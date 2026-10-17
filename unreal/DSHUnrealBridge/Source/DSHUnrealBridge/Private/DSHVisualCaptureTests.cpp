#if WITH_DEV_AUTOMATION_TESTS
#include "DSHVisualCapture.h"

#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "LevelEditorViewport.h"
#include "Math/PerspectiveMatrix.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "RenderingThread.h"
#include "UnrealClient.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHVisualProjection, "DSH.Bridge.VisualCapture.Projection",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHVisualProjection::RunTest(const FString&)
{
    // This matrix looks down +Z with a reversed-Z near plane at Z=1.
    const FMatrix Projection = FReversedZPerspectiveMatrix(PI / 4, 1.0, 1.0, 1.0);
    const FIntRect Viewport(0, 0, 100, 100);
    FIntRect Rect; bool bNear = false, bScreen = false; FString Error;
    TestTrue(TEXT("Visible bounds project"), FDSHVisualCapture::ProjectBounds(
        FBox(FVector(-1, -1, 9), FVector(1, 1, 11)), Projection, Viewport, Rect, bNear, bScreen, Error));
    TestTrue(TEXT("Visible target contains viewport center"), Rect.Contains(FIntPoint(50, 50)));
    TestFalse(TEXT("Visible target is not near clipped"), bNear); TestFalse(TEXT("Visible target is not screen clipped"), bScreen);
    TestFalse(TEXT("Behind-camera bounds are rejected"), FDSHVisualCapture::ProjectBounds(
        FBox(FVector(-1, -1, -11), FVector(1, 1, -9)), Projection, Viewport, Rect, bNear, bScreen, Error));
    TestEqual(TEXT("Behind-camera error"), Error, FString(TEXT("TARGET_BEHIND_CAMERA")));
    TestFalse(TEXT("Offscreen bounds are rejected"), FDSHVisualCapture::ProjectBounds(
        FBox(FVector(100, -1, 9), FVector(102, 1, 11)), Projection, Viewport, Rect, bNear, bScreen, Error));
    TestEqual(TEXT("Offscreen error"), Error, FString(TEXT("TARGET_OFFSCREEN")));
    TestFalse(TEXT("Bounds entirely before near plane are rejected"), FDSHVisualCapture::ProjectBounds(
        FBox(FVector(-.1, -.1, .1), FVector(.1, .1, .5)), Projection, Viewport, Rect, bNear, bScreen, Error));
    TestEqual(TEXT("Near-plane error"), Error, FString(TEXT("TARGET_BEFORE_NEAR_PLANE")));
    TestTrue(TEXT("Bounds crossing camera and near plane project safely"), FDSHVisualCapture::ProjectBounds(
        FBox(FVector(-2, -2, -2), FVector(2, 2, 2)), Projection, Viewport, Rect, bNear, bScreen, Error));
    TestTrue(TEXT("Crossing near plane is reported"), bNear);
    TestEqual(TEXT("Camera-crossing bounds safely cover viewport"), Rect, Viewport);
    TestTrue(TEXT("Partial offscreen bounds project"), FDSHVisualCapture::ProjectBounds(
        FBox(FVector(8, -1, 9), FVector(12, 1, 11)), Projection, Viewport, Rect, bNear, bScreen, Error));
    TestTrue(TEXT("Partial clipping is reported"), bScreen);
    TestEqual(TEXT("Partial bounds clamp to viewport"), Rect.Max.X, 100);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHVisualCaptureValidation, "DSH.Bridge.VisualCapture.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHVisualCaptureValidation::RunTest(const FString&)
{
    FString Error, Code;
    auto Params = MakeShared<FJsonObject>(); Params->SetStringField(TEXT("outputDir"), TEXT("relative/capture"));
    TestFalse(TEXT("Relative output paths are rejected"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Relative path error"), Code, FString(TEXT("INVALID_OUTPUT_DIRECTORY")));
    Params->SetStringField(TEXT("outputDir"), TEXT("//server/share/capture"));
    TestFalse(TEXT("Network output paths are rejected"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Network path error"), Code, FString(TEXT("INVALID_OUTPUT_DIRECTORY")));
    Params->SetStringField(TEXT("outputDir"), FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir()));
    Params->SetStringField(TEXT("source"), TEXT("pie"));
    TestFalse(TEXT("Unsupported source is rejected"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Unsupported source error"), Code, FString(TEXT("CAPTURE_SOURCE_UNSUPPORTED")));
    Params->RemoveField(TEXT("source")); Params->SetNumberField(TEXT("padding"), 1.5);
    TestFalse(TEXT("Fractional padding is rejected"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Fractional padding error"), Code, FString(TEXT("INVALID_REQUEST")));
    Params->RemoveField(TEXT("padding")); Params->SetStringField(TEXT("targetPath"), TEXT("/Game/SomeActor"));
    Params->SetObjectField(TEXT("region"), MakeShared<FJsonObject>());
    TestFalse(TEXT("Ambiguous target and region are rejected"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Ambiguous target error"), Code, FString(TEXT("INVALID_REQUEST")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHVisualCaptureRendered, "DSH.Bridge.VisualCapture.RenderedViewport",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHVisualCaptureRendered::RunTest(const FString&)
{
    // Run in an editor with a real renderer (for unattended runs use -RenderOffscreen,
    // not -NullRHI). This fixture verifies pixels, bounds and restored viewport state.
    FLevelEditorViewportClient* Client = GCurrentLevelEditingViewportClient;
    if (!TestNotNull(TEXT("A level viewport exists for GPU capture test"), Client) || !Client->Viewport) return false;
    UWorld* World = Client->GetWorld();
    if (!TestNotNull(TEXT("Editor world exists"), World)) return false;
    const FVector PreviousLocation = Client->GetViewLocation(); const FRotator PreviousRotation = Client->GetViewRotation();
    const FEngineShowFlags PreviousFlags = Client->EngineShowFlags;
    const bool bPreviousWidget = Client->GetShowWidget(); const EViewModeIndex PreviousMode = Client->GetViewMode();
    const bool bWasDirty = World->GetOutermost()->IsDirty();
    const FString Root = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("DSHBridgeTests") / FGuid::NewGuid().ToString(EGuidFormats::Digits));
    FActorSpawnParameters Spawn; Spawn.ObjectFlags = RF_Transient;
    AActor* Actor = World->SpawnActor<AActor>(Spawn);
    if (!TestNotNull(TEXT("Fixture actor exists"), Actor)) return false;
    UStaticMeshComponent* Mesh = NewObject<UStaticMeshComponent>(Actor, TEXT("VisualCaptureCube"), RF_Transient);
    Actor->AddInstanceComponent(Mesh); Actor->SetRootComponent(Mesh);
    Mesh->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"))); Mesh->RegisterComponent();
    Actor->SetActorLocation(FVector(500, 0, 100));
    Client->SetViewLocation(FVector(0, 0, 100)); Client->SetViewRotation(FRotator::ZeroRotator);
    Client->SetViewMode(VMI_Unlit); Client->EngineShowFlags.SetSelection(true); Client->EngineShowFlags.SetSelectionOutline(true);
    Client->EngineShowFlags.SetModeWidgets(true); Client->ShowWidget(true);
    FlushRenderingCommands();

    auto Params = MakeShared<FJsonObject>(); Params->SetStringField(TEXT("outputDir"), Root / TEXT("actor"));
    Params->SetStringField(TEXT("targetPath"), Actor->GetPathName());
    FString Error, Code; const auto Capture = FDSHVisualCapture::Capture(Params, Error, Code);
    if (TestTrue(*FString::Printf(TEXT("GPU actor capture succeeds (%s: %s)"), *Code, *Error), Capture.IsValid()))
    {
        TestTrue(TEXT("Full PNG exists"), IFileManager::Get().FileExists(*Capture->GetStringField(TEXT("fullPath"))));
        TestTrue(TEXT("Crop PNG exists"), IFileManager::Get().FileExists(*Capture->GetStringField(TEXT("cropPath"))));
        TestTrue(TEXT("Metadata exists"), IFileManager::Get().FileExists(*Capture->GetStringField(TEXT("metadataPath"))));
        const auto Crop = Capture->GetObjectField(TEXT("crop")); const auto Viewport = Capture->GetObjectField(TEXT("viewport"));
        TestTrue(TEXT("Actor crop is smaller than full viewport"), Crop->GetNumberField(TEXT("width")) < Viewport->GetNumberField(TEXT("width")));
        TestTrue(TEXT("Crop has positive height"), Crop->GetNumberField(TEXT("height")) > 0);
        TArray<uint8> Png;
        TestTrue(TEXT("Crop PNG can be read"), FFileHelper::LoadFileToArray(Png, *Capture->GetStringField(TEXT("cropPath"))));
        TestTrue(TEXT("Crop is an encoded PNG"), Png.Num() > 8 && Png[0] == 137 && Png[1] == 80 && Png[2] == 78 && Png[3] == 71);
        TestFalse(TEXT("Bounding rectangle is explicitly not a mask"), Capture->GetObjectField(TEXT("target"))->GetBoolField(TEXT("visibilityMask")));
        TestFalse(TEXT("Existing capture is not overwritten"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
        TestEqual(TEXT("Existing output error"), Code, FString(TEXT("CAPTURE_OUTPUT_EXISTS")));
    }
    TestTrue(TEXT("Selection show flag restored"), !!Client->EngineShowFlags.Selection);
    TestTrue(TEXT("Selection outline restored"), !!Client->EngineShowFlags.SelectionOutline);
    TestTrue(TEXT("Gizmo show flag restored"), !!Client->EngineShowFlags.ModeWidgets);
    TestTrue(TEXT("Widget visibility restored"), Client->GetShowWidget());
    Params->SetStringField(TEXT("outputDir"), Root / TEXT("component")); Params->SetStringField(TEXT("targetPath"), Mesh->GetPathName());
    TestTrue(TEXT("Live primitive component can be captured"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    Actor->SetActorLocation(FVector(-500, 0, 100)); Params->SetStringField(TEXT("outputDir"), Root / TEXT("behind"));
    Params->SetStringField(TEXT("targetPath"), Actor->GetPathName());
    TestFalse(TEXT("Behind-camera Actor fails"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Behind-camera Actor error"), Code, FString(TEXT("TARGET_BEHIND_CAMERA")));
    Params->SetStringField(TEXT("targetPath"), GetMutableDefault<UStaticMeshComponent>()->GetPathName());
    TestFalse(TEXT("Class default component is rejected"), FDSHVisualCapture::Capture(Params, Error, Code).IsValid());
    TestEqual(TEXT("Template error"), Code, FString(TEXT("TARGET_TEMPLATE_UNSUPPORTED")));
    Params->RemoveField(TEXT("targetPath")); Params->SetStringField(TEXT("outputDir"), Root / TEXT("region"));
    auto Region = MakeShared<FJsonObject>(); Region->SetNumberField(TEXT("x"), 0); Region->SetNumberField(TEXT("y"), 0);
    Region->SetNumberField(TEXT("width"), 32); Region->SetNumberField(TEXT("height"), 24); Params->SetObjectField(TEXT("region"), Region);
    const auto RegionCapture = FDSHVisualCapture::Capture(Params, Error, Code);
    if (TestTrue(TEXT("Explicit pixel region can be captured"), RegionCapture.IsValid()))
    {
        TestEqual(TEXT("Region width"), RegionCapture->GetObjectField(TEXT("crop"))->GetNumberField(TEXT("width")), 32.0);
        TestEqual(TEXT("Region height"), RegionCapture->GetObjectField(TEXT("crop"))->GetNumberField(TEXT("height")), 24.0);
    }
    World->DestroyActor(Actor); World->GetOutermost()->SetDirtyFlag(bWasDirty);
    Client->SetViewLocation(PreviousLocation); Client->SetViewRotation(PreviousRotation); Client->SetViewMode(PreviousMode);
    Client->EngineShowFlags = PreviousFlags; Client->ShowWidget(bPreviousWidget); Client->Viewport->Invalidate();
    AddInfo(TEXT("GPU capture artifacts: ") + Root);
    return true;
}
#endif
