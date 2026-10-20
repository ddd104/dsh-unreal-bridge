#include "ProjectKnowledgeTools.h"

namespace ProjectKnowledgeTools
{
    namespace
    {
        const FTool Tools[] = {
#define DSH_KNOWLEDGE_TOOL(Name, Backend, Write, Bridge) {TEXT(Name), EBackend::Backend, Write, Bridge},
#include "ProjectKnowledgeTools.inl"
#undef DSH_KNOWLEDGE_TOOL
        };
    }

    TConstArrayView<FTool> All()
    {
        return MakeArrayView(Tools);
    }

    const FTool* Find(const FString& Name)
    {
        for (const FTool& Tool : Tools)
            if (Name == Tool.Name) return &Tool;
        return nullptr;
    }
}
