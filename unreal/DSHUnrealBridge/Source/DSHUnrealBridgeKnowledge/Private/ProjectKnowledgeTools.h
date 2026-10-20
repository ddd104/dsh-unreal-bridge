#pragma once

#include "CoreMinimal.h"

namespace ProjectKnowledgeTools
{
    enum class EBackend { Worker, Snapshot, Editor };

    struct FTool
    {
        const TCHAR* Name;
        EBackend Backend;
        bool bWrite;
        bool bBridgeExposed;
    };

    TConstArrayView<FTool> All();
    const FTool* Find(const FString& Name);
}
