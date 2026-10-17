#include "DSHVisualCapture.h"

#include "Components/PrimitiveComponent.h"
#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "RenderingThread.h"
#include "SceneView.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UnrealClient.h"
#include "UObject/UObjectGlobals.h"

namespace
{
constexpr int64 MaximumCapturePixels = 8LL * 1024 * 1024;

TSharedPtr<FJsonObject> RectJson(const FIntRect& Rect)
{
    auto Json = MakeShared<FJsonObject>();
    Json->SetNumberField(TEXT("x"), Rect.Min.X); Json->SetNumberField(TEXT("y"), Rect.Min.Y);
    Json->SetNumberField(TEXT("width"), Rect.Width()); Json->SetNumberField(TEXT("height"), Rect.Height());
    return Json;
}

TArray<TSharedPtr<FJsonValue>> VectorJson(const FVector& V)
{
    return { MakeShared<FJsonValueNumber>(V.X), MakeShared<FJsonValueNumber>(V.Y), MakeShared<FJsonValueNumber>(V.Z) };
}

TArray<TSharedPtr<FJsonValue>> MatrixJson(const FMatrix& Matrix)
{
    TArray<TSharedPtr<FJsonValue>> Rows;
    for (int32 Row = 0; Row < 4; ++Row)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (int32 Column = 0; Column < 4; ++Column) Values.Add(MakeShared<FJsonValueNumber>(Matrix.M[Row][Column]));
        Rows.Add(MakeShared<FJsonValueArray>(Values));
    }
    return Rows;
}

bool ReadInteger(const TSharedPtr<FJsonObject>& Object, const TCHAR* Key, int32& Out)
{
    double Value = 0;
    if (!Object || !Object->TryGetNumberField(Key, Value) || !FMath::IsFinite(Value)
        || Value < MIN_int32 || Value > MAX_int32 || FMath::TruncToDouble(Value) != Value) return false;
    Out = static_cast<int32>(Value);
    return true;
}

bool IsAbsoluteLocalDirectory(FString& Directory)
{
    FPaths::NormalizeDirectoryName(Directory);
    if (Directory.IsEmpty() || Directory.Contains(TEXT("://")) || Directory.StartsWith(TEXT("//"))
        || Directory.Contains(TEXT("\n")) || Directory.Contains(TEXT("\r"))) return false;
#if PLATFORM_WINDOWS
    // Excludes drive-relative paths, UNC paths, device paths and remote shares.
    if (Directory.Len() < 3 || !FChar::IsAlpha(Directory[0]) || Directory[1] != TEXT(':') || Directory[2] != TEXT('/')) return false;
#else
    if (!Directory.StartsWith(TEXT("/"))) return false;
#endif
    if (!FPaths::CollapseRelativeDirectories(Directory)) return false;
    Directory = FPaths::ConvertRelativePathToFull(Directory);
    FPaths::NormalizeDirectoryName(Directory);
    return true;
}

FLevelEditorViewportClient* FindViewport()
{
    if (!GEditor) return nullptr;
    FViewport* Active = GEditor->GetActiveViewport();
    const auto& Clients = GEditor->GetLevelViewportClients();
    for (FLevelEditorViewportClient* Client : Clients)
        if (Client && Client->Viewport && Client->Viewport == Active) return Client;
    // The active application window can be DSH or the Content Browser; use the
    // editor's most recently active level viewport, never an asset preview.
    if (GCurrentLevelEditingViewportClient && Clients.Contains(GCurrentLevelEditingViewportClient))
        return GCurrentLevelEditingViewportClient;
    return nullptr;
}

struct FScopedCleanViewport
{
    FLevelEditorViewportClient& Client;
    FEngineShowFlags ShowFlags;
    bool bShowWidget;
    explicit FScopedCleanViewport(FLevelEditorViewportClient& InClient)
        : Client(InClient), ShowFlags(InClient.EngineShowFlags), bShowWidget(InClient.GetShowWidget())
    {
        Client.EngineShowFlags.SetSelection(false);
        Client.EngineShowFlags.SetSelectionOutline(false);
        Client.EngineShowFlags.SetModeWidgets(false);
        Client.ShowWidget(false);
    }
    ~FScopedCleanViewport()
    {
        Client.EngineShowFlags = ShowFlags;
        Client.ShowWidget(bShowWidget);
        if (Client.Viewport) Client.Viewport->Invalidate();
    }
};

bool WritePng(const FString& Path, int32 Width, int32 Height, const TArray<FColor>& Pixels)
{
    TArray64<uint8> Png;
    FImageUtils::PNGCompressImageArray(Width, Height, TArrayView64<const FColor>(Pixels.GetData(), Pixels.Num()), Png);
    return !Png.IsEmpty() && FFileHelper::SaveArrayToFile(Png, *Path);
}
}

bool FDSHVisualCapture::ProjectBounds(const FBox& Bounds, const FMatrix& ViewProjection, const FIntRect& ViewRect,
    FIntRect& OutRect, bool& bNearClipped, bool& bScreenClipped, FString& ErrorCode)
{
    bNearClipped = false; bScreenClipped = false; OutRect = FIntRect(); ErrorCode.Reset();
    if (!Bounds.IsValid || Bounds.Min.ContainsNaN() || Bounds.Max.ContainsNaN() || ViewRect.Width() <= 0 || ViewRect.Height() <= 0)
    { ErrorCode = TEXT("TARGET_BOUNDS_INVALID"); return false; }

    FVector4 Corners[8];
    bool bAnyInFront = false;
    for (int32 I = 0; I < 8; ++I)
    {
        const FVector Point((I & 1) ? Bounds.Max.X : Bounds.Min.X,
            (I & 2) ? Bounds.Max.Y : Bounds.Min.Y, (I & 4) ? Bounds.Max.Z : Bounds.Min.Z);
        Corners[I] = ViewProjection.TransformFVector4(FVector4(Point, 1.0));
        if (Corners[I].ContainsNaN()) { ErrorCode = TEXT("TARGET_BOUNDS_INVALID"); return false; }
        bAnyInFront |= Corners[I].W > UE_DOUBLE_SMALL_NUMBER;
    }
    if (!bAnyInFront) { ErrorCode = TEXT("TARGET_BEHIND_CAMERA"); return false; }

    // Unreal uses reversed Z: the near clip plane is Z <= W. Keep the
    // homogeneous W positive too, so crossing the camera cannot invert a crop.
    TArray<FVector4, TInlineAllocator<32>> Points;
    auto PlaneDistance = [](const FVector4& P, int32 Plane) { return Plane == 0 ? P.W - 1.e-6 : P.W - P.Z; };
    for (int32 I = 0; I < 8; ++I)
    {
        if (PlaneDistance(Corners[I], 0) >= 0 && PlaneDistance(Corners[I], 1) >= 0) Points.Add(Corners[I]);
        else bNearClipped = true;
        for (int32 Axis = 0; Axis < 3; ++Axis)
        {
            const int32 J = I ^ (1 << Axis);
            if (I > J) continue;
            FVector4 A = Corners[I], B = Corners[J];
            bool bKept = true;
            for (int32 Plane = 0; Plane < 2; ++Plane)
            {
                const double DA = PlaneDistance(A, Plane), DB = PlaneDistance(B, Plane);
                if (DA < 0 && DB < 0) { bKept = false; break; }
                if ((DA < 0) != (DB < 0))
                {
                    const FVector4 Intersection = A + (B - A) * (DA / (DA - DB));
                    if (DA < 0) A = Intersection; else B = Intersection;
                }
            }
            if (bKept) { Points.Add(A); Points.Add(B); }
        }
    }
    if (Points.IsEmpty()) { ErrorCode = TEXT("TARGET_BEFORE_NEAR_PLANE"); return false; }

    double MinX = TNumericLimits<double>::Max(), MinY = MinX;
    double MaxX = -MinX, MaxY = -MinX;
    for (const FVector4& P : Points)
    {
        if (P.W <= 0) continue;
        const double X = ViewRect.Min.X + (P.X / P.W + 1.0) * ViewRect.Width() * 0.5;
        const double Y = ViewRect.Min.Y + (1.0 - P.Y / P.W) * ViewRect.Height() * 0.5;
        MinX = FMath::Min(MinX, X); MinY = FMath::Min(MinY, Y);
        MaxX = FMath::Max(MaxX, X); MaxY = FMath::Max(MaxY, Y);
    }
    if (MaxX <= ViewRect.Min.X || MaxY <= ViewRect.Min.Y || MinX >= ViewRect.Max.X || MinY >= ViewRect.Max.Y)
    { ErrorCode = TEXT("TARGET_OFFSCREEN"); return false; }
    bScreenClipped = MinX < ViewRect.Min.X || MinY < ViewRect.Min.Y || MaxX > ViewRect.Max.X || MaxY > ViewRect.Max.Y;
    // Clamp before integer conversion, including bounds that cross the camera.
    OutRect = FIntRect(FMath::FloorToInt(FMath::Clamp(MinX, double(ViewRect.Min.X), double(ViewRect.Max.X))),
        FMath::FloorToInt(FMath::Clamp(MinY, double(ViewRect.Min.Y), double(ViewRect.Max.Y))),
        FMath::CeilToInt(FMath::Clamp(MaxX, double(ViewRect.Min.X), double(ViewRect.Max.X))),
        FMath::CeilToInt(FMath::Clamp(MaxY, double(ViewRect.Min.Y), double(ViewRect.Max.Y))));
    if (OutRect.Width() <= 0 || OutRect.Height() <= 0) { ErrorCode = TEXT("TARGET_BOUNDS_EMPTY"); return false; }
    return true;
}

TSharedPtr<FJsonObject> FDSHVisualCapture::Capture(const TSharedPtr<FJsonObject>& Params, FString& Error, FString& ErrorCode)
{
    Error.Reset(); ErrorCode.Reset();
    auto Fail = [&Error, &ErrorCode](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject>
    { ErrorCode = Code; Error = Message; return nullptr; };
    if (!IsInGameThread()) return Fail(TEXT("CAPTURE_THREAD_INVALID"), TEXT("Visual capture must run on the editor game thread"));
    if (!Params) return Fail(TEXT("INVALID_REQUEST"), TEXT("Capture parameters are required"));
    FString Source = TEXT("editor");
    if (Params->HasField(TEXT("source")) && !Params->TryGetStringField(TEXT("source"), Source))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("source must be a string"));
    if (Source != TEXT("editor")) return Fail(TEXT("CAPTURE_SOURCE_UNSUPPORTED"), TEXT("Only the current editor level viewport is supported; PIE and UMG capture are not available"));
    FString Directory;
    if (!Params->TryGetStringField(TEXT("outputDir"), Directory) || !IsAbsoluteLocalDirectory(Directory))
        return Fail(TEXT("INVALID_OUTPUT_DIRECTORY"), TEXT("outputDir must be an absolute local filesystem directory"));
    FString TargetPath;
    if (Params->HasField(TEXT("targetPath")) && (!Params->TryGetStringField(TEXT("targetPath"), TargetPath) || TargetPath.IsEmpty()))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("targetPath must be a nonempty exact live object path"));
    const bool bRegion = Params->HasField(TEXT("region"));
    if (bRegion && !TargetPath.IsEmpty()) return Fail(TEXT("INVALID_REQUEST"), TEXT("Specify either targetPath or region, not both"));
    int32 Padding = 8;
    if (Params->HasField(TEXT("padding")) && (!ReadInteger(Params, TEXT("padding"), Padding) || Padding < 0 || Padding > 4096))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("padding must be an integer from 0 through 4096 pixels"));

    FLevelEditorViewportClient* Client = FindViewport();
    if (!Client || !Client->Viewport) return Fail(TEXT("VIEWPORT_UNAVAILABLE"), TEXT("Open and activate an editor level viewport before capturing"));
    UWorld* World = Client->GetWorld();
    if (!World || World->WorldType != EWorldType::Editor)
        return Fail(TEXT("CAPTURE_WORLD_UNSUPPORTED"), TEXT("The current viewport is displaying PIE or simulation; return to the editor world before capturing"));
    if (Client->IsEngineShowFlagsOverrideEnabled())
        return Fail(TEXT("VIEWPORT_OVERRIDE_ACTIVE"), TEXT("The viewport has a custom show flag override; disable it before capturing"));
    if (FScreenshotRequest::IsScreenshotRequested() || GIsHighResScreenshot)
        return Fail(TEXT("SCREENSHOT_IN_PROGRESS"), TEXT("An Unreal screenshot is already pending; wait for it to finish before capturing"));
    FViewport* Viewport = Client->Viewport;
    const FIntPoint Size = Viewport->GetSizeXY();
    if (Size.X <= 0 || Size.Y <= 0 || int64(Size.X) * Size.Y > MaximumCapturePixels)
        return Fail(TEXT("VIEWPORT_SIZE_INVALID"), TEXT("Viewport dimensions must be nonzero and no more than 8 Mi pixels"));
    if (Viewport->GetSceneHDREnabled())
        return Fail(TEXT("HDR_VIEWPORT_UNSUPPORTED"), TEXT("HDR viewport capture needs a defined color conversion; use an SDR viewport for this comparison"));
    const FIntRect FullRect(0, 0, Size.X, Size.Y);
    FIntRect CropRect = FullRect;
    auto Target = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Warnings;
    auto Warn = [&Warnings](const TCHAR* Message) { Warnings.Add(MakeShared<FJsonValueString>(Message)); };

    FSceneViewFamilyContext ViewFamily(FSceneViewFamily::ConstructionValues(Viewport, Client->GetScene(), Client->EngineShowFlags)
        .SetRealtimeUpdate(Client->IsRealtime()));
    FSceneView* View = Client->CalcSceneView(&ViewFamily);
    if (!View) return Fail(TEXT("VIEWPORT_VIEW_UNAVAILABLE"), TEXT("Could not calculate the current viewport camera"));

    if (!TargetPath.IsEmpty())
    {
        // Deliberately do not load assets or resolve labels: only this exact live instance qualifies.
        UObject* Object = FindObject<UObject>(nullptr, *TargetPath);
        if (!IsValid(Object) || Object->GetPathName() != TargetPath)
            return Fail(TEXT("TARGET_NOT_FOUND"), TEXT("targetPath does not identify an exact currently loaded object instance"));
        if (Object->IsTemplate())
            return Fail(TEXT("TARGET_TEMPLATE_UNSUPPORTED"), TEXT("Blueprint component templates and class defaults cannot be captured; use an Actor or component instance in the current level"));
        AActor* Actor = Cast<AActor>(Object);
        UPrimitiveComponent* Component = Cast<UPrimitiveComponent>(Object);
        if (!Actor && !Component)
            return Fail(TEXT("TARGET_TYPE_UNSUPPORTED"), TEXT("targetPath must identify a level Actor or a primitive component with render bounds"));
        AActor* Owner = Actor ? Actor : Component->GetOwner();
        if (!IsValid(Owner) || Owner->IsTemplate() || Owner->GetWorld() != World || Object->GetWorld() != World)
            return Fail(TEXT("TARGET_WORLD_MISMATCH"), TEXT("The target must be a live instance in the current viewport's editor world"));
        if (Owner->IsHiddenEd() || (Component && (!Component->IsRegistered() || !Component->IsVisible())))
            return Fail(TEXT("TARGET_HIDDEN"), TEXT("The target is hidden or its component is not registered and visible"));
        const FBox Bounds = Actor ? Actor->GetComponentsBoundingBox(true) : Component->Bounds.GetBox();
        bool bNearClipped = false, bScreenClipped = false;
        FString ProjectionError;
        if (!ProjectBounds(Bounds, View->ViewMatrices.GetWorldToClip(), View->UnscaledViewRect,
            CropRect, bNearClipped, bScreenClipped, ProjectionError))
            return Fail(*ProjectionError, TEXT("The target bounds do not produce a visible crop in the current camera; reposition the camera or target"));
        const FIntRect BoundsRect = CropRect;
        CropRect.Min.X = FMath::Max(0, CropRect.Min.X - Padding); CropRect.Min.Y = FMath::Max(0, CropRect.Min.Y - Padding);
        CropRect.Max.X = FMath::Min(Size.X, CropRect.Max.X + Padding); CropRect.Max.Y = FMath::Min(Size.Y, CropRect.Max.Y + Padding);
        Target->SetStringField(TEXT("kind"), Actor ? TEXT("actor") : TEXT("component"));
        Target->SetStringField(TEXT("path"), Object->GetPathName());
        Target->SetStringField(TEXT("ownerPath"), Owner->GetPathName());
        Target->SetStringField(TEXT("label"), Actor ? Actor->GetActorLabel() : Object->GetName());
        Target->SetStringField(TEXT("class"), Object->GetClass()->GetPathName());
        Target->SetArrayField(TEXT("boundsMin"), VectorJson(Bounds.Min)); Target->SetArrayField(TEXT("boundsMax"), VectorJson(Bounds.Max));
        Target->SetObjectField(TEXT("projectedBounds"), RectJson(BoundsRect));
        Target->SetBoolField(TEXT("nearPlaneClipped"), bNearClipped); Target->SetBoolField(TEXT("screenClipped"), bScreenClipped);
        Target->SetStringField(TEXT("coverage"), TEXT("world-axis-aligned-bounds"));
        Target->SetBoolField(TEXT("visibilityMask"), false);
        Warn(TEXT("Target crop is a projected bounds rectangle, not an object mask; it may include background, other objects, or occlusion."));
        if (bNearClipped) Warn(TEXT("The target intersects the camera near plane; its projected bounds were clipped before cropping."));
        if (bScreenClipped) Warn(TEXT("Part of the target bounds extends outside the viewport."));
    }
    else if (bRegion)
    {
        const TSharedPtr<FJsonObject>* Region = nullptr;
        int32 X, Y, Width, Height;
        if (!Params->TryGetObjectField(TEXT("region"), Region) || !Region || !ReadInteger(*Region, TEXT("x"), X)
            || !ReadInteger(*Region, TEXT("y"), Y) || !ReadInteger(*Region, TEXT("width"), Width)
            || !ReadInteger(*Region, TEXT("height"), Height) || Width <= 0 || Height <= 0)
            return Fail(TEXT("INVALID_REGION"), TEXT("region requires integer x, y and positive integer width, height in viewport pixels"));
        const int64 Right = int64(X) + Width, Bottom = int64(Y) + Height;
        if (Right <= 0 || Bottom <= 0 || X >= Size.X || Y >= Size.Y)
            return Fail(TEXT("REGION_OFFSCREEN"), TEXT("The requested region does not intersect the viewport"));
        CropRect = FIntRect(FMath::Max(0, X), FMath::Max(0, Y), static_cast<int32>(FMath::Min<int64>(Size.X, Right)),
            static_cast<int32>(FMath::Min<int64>(Size.Y, Bottom)));
        Target->SetStringField(TEXT("kind"), TEXT("region")); Target->SetObjectField(TEXT("requestedRegion"), *Region);
        if (X < 0 || Y < 0 || Right > Size.X || Bottom > Size.Y) Warn(TEXT("The requested region was clipped to the viewport."));
    }
    else Target->SetStringField(TEXT("kind"), TEXT("viewport"));
    CropRect.Clip(FullRect);
    if (CropRect.Width() <= 0 || CropRect.Height() <= 0) return Fail(TEXT("TARGET_OFFSCREEN"), TEXT("The target crop does not intersect the viewport"));

    const FString FullPath = FPaths::Combine(Directory, TEXT("viewport.png"));
    const FString CropPath = FPaths::Combine(Directory, TEXT("crop.png"));
    const FString MetadataPath = FPaths::Combine(Directory, TEXT("capture.json"));
    if (IFileManager::Get().FileExists(*FullPath) || IFileManager::Get().FileExists(*CropPath) || IFileManager::Get().FileExists(*MetadataPath))
        return Fail(TEXT("CAPTURE_OUTPUT_EXISTS"), TEXT("Capture output files already exist; use a new outputDir for each capture"));
    if (!IFileManager::Get().MakeDirectory(*Directory, true))
        return Fail(TEXT("CAPTURE_DIRECTORY_FAILED"), TEXT("Could not create the capture output directory"));

    TArray<FColor> Pixels;
    const FString CapturedAt = FDateTime::UtcNow().ToIso8601();
    const uint64 CapturedFrame = GFrameCounter;
    {
        FScopedCleanViewport Clean(*Client);
        // Read the same viewport renderer used by the editor. No scene capture,
        // global screenshot queue, camera movement, selection changes or saving.
        Viewport->Draw(false);
        FlushRenderingCommands();
        if (Viewport->GetSizeXY() != Size || !Viewport->ReadPixels(Pixels) || Pixels.Num() != int64(Size.X) * Size.Y)
            return Fail(TEXT("CAPTURE_READ_FAILED"), TEXT("Viewport pixel readback failed or the viewport was resized during capture"));
    }
    for (FColor& Pixel : Pixels) Pixel.A = 255;
    TArray<FColor> Cropped;
    Cropped.SetNumUninitialized(CropRect.Width() * CropRect.Height());
    for (int32 Row = 0; Row < CropRect.Height(); ++Row)
        FMemory::Memcpy(Cropped.GetData() + Row * CropRect.Width(), Pixels.GetData() + (CropRect.Min.Y + Row) * Size.X + CropRect.Min.X,
            SIZE_T(CropRect.Width()) * sizeof(FColor));
    if (!WritePng(FullPath, Size.X, Size.Y, Pixels) || !WritePng(CropPath, CropRect.Width(), CropRect.Height(), Cropped))
        return Fail(TEXT("CAPTURE_WRITE_FAILED"), TEXT("Could not write captured PNG files"));

    auto Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("schemaVersion"), 1); Result->SetStringField(TEXT("source"), TEXT("editor"));
    Result->SetStringField(TEXT("fullPath"), FullPath); Result->SetStringField(TEXT("cropPath"), CropPath);
    Result->SetStringField(TEXT("metadataPath"), MetadataPath); Result->SetStringField(TEXT("capturedAt"), CapturedAt);
    Result->SetStringField(TEXT("frameNumber"), LexToString(CapturedFrame));
    Result->SetStringField(TEXT("projectPath"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
    Result->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName()); Result->SetStringField(TEXT("worldPath"), World->GetPathName());
    Result->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
    Result->SetObjectField(TEXT("viewport"), RectJson(FullRect)); Result->SetObjectField(TEXT("viewRect"), RectJson(View->UnscaledViewRect));
    Result->SetObjectField(TEXT("crop"), RectJson(CropRect)); Result->SetObjectField(TEXT("target"), Target);
    auto Camera = MakeShared<FJsonObject>();
    Camera->SetArrayField(TEXT("location"), VectorJson(View->ViewLocation));
    Camera->SetArrayField(TEXT("rotation"), { MakeShared<FJsonValueNumber>(View->ViewRotation.Pitch),
        MakeShared<FJsonValueNumber>(View->ViewRotation.Yaw), MakeShared<FJsonValueNumber>(View->ViewRotation.Roll) });
    Camera->SetBoolField(TEXT("perspective"), View->IsPerspectiveProjection()); Camera->SetNumberField(TEXT("horizontalFov"), Client->ViewFOV);
    Camera->SetNumberField(TEXT("orthoZoom"), Client->GetOrthoZoom());
    Camera->SetArrayField(TEXT("viewProjectionMatrix"), MatrixJson(View->ViewMatrices.GetWorldToClip()));
    Result->SetObjectField(TEXT("camera"), Camera);
    auto Render = MakeShared<FJsonObject>();
    Render->SetNumberField(TEXT("viewMode"), static_cast<int32>(Client->GetViewMode()));
    Render->SetBoolField(TEXT("realtime"), Client->IsRealtime()); Render->SetBoolField(TEXT("gameView"), Client->IsInGameView());
    Render->SetBoolField(TEXT("fixedExposure"), Client->ExposureSettings.bFixed);
    Render->SetNumberField(TEXT("fixedEV100"), Client->ExposureSettings.FixedEV100);
    Render->SetBoolField(TEXT("eyeAdaptation"), !!Client->EngineShowFlags.EyeAdaptation);
    Render->SetBoolField(TEXT("postProcessing"), !!Client->EngineShowFlags.PostProcessing);
    Render->SetBoolField(TEXT("motionBlur"), !!Client->EngineShowFlags.MotionBlur);
    Render->SetBoolField(TEXT("temporalAA"), !!Client->EngineShowFlags.TemporalAA);
    Render->SetBoolField(TEXT("grid"), !!Client->EngineShowFlags.Grid);
    Render->SetStringField(TEXT("colorEncoding"), TEXT("viewport-readback-rgba8"));
    Render->SetBoolField(TEXT("selectionOverlaysRemoved"), true); Render->SetBoolField(TEXT("hdr"), false);
    Result->SetObjectField(TEXT("render"), Render);
    Warn(TEXT("A single viewport frame is captured. Animation, temporal accumulation, exposure, lighting and camera differences can affect comparison."));
    Result->SetArrayField(TEXT("warnings"), Warnings);
    FString Json;
    if (!FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json))
        || !FFileHelper::SaveStringToFile(Json, *MetadataPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
        return Fail(TEXT("CAPTURE_WRITE_FAILED"), TEXT("PNG files were written but capture metadata could not be saved"));
    return Result;
}
