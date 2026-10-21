#pragma once

#include "CoreMinimal.h"
#include "DSHAssetViewHint.h"
#include "Dom/JsonObject.h"

/** Native, staged edits of existing UMaterial / ordinary UMaterialFunction assets.
 *  A successful patch is deliberately unsaved. No third-party MCP transaction is used.
 */
class FDSHMaterialOps
{
public:
    static TSharedPtr<FJsonObject> Execute(const FString& Method, const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails,
        FDSHAssetViewHint* ViewHint = nullptr);
    static FString Revision(UObject* Asset);

#if WITH_DEV_AUTOMATION_TESTS
    /** Called after the real edit, before verification, to test rollback after partial writes. */
    static TFunction<void(UObject*)> TestAfterApply;
#endif
};
