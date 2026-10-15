import { GraphStore, createFileNode, symbolNodeId } from "../graph/graphStore.js";
import type { NodeType } from "../graph/schema.js";

// 带行号的轻量词法索引，不将近似的类、函数与绑定关系当成完整 AST 或运行时事实。
export function indexAngelScriptFile(input: { relativePath: string; content: string; system: string }, store: GraphStore): void {
  const { relativePath, content, system } = input;
  const file = store.addNode(createFileNode(relativePath, system, "AngelScript"));
  const lines = content.split(/\r?\n/);
  let owner = file.id;
  let blockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (blockComment) { const end = line.indexOf("*/"); if (end < 0) continue; line = line.slice(end + 2); blockComment = false; }
    line = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
    const start = line.indexOf("/*"); if (start >= 0) { line = line.slice(0,start); blockComment = true; }
    const klass = line.match(/\b(class|struct|enum)\s+(\w+)(?:\s*:\s*(\w+))?/);
    const func = line.match(/^\s*(?:(?:private|protected|public|override|final|const)\s+)*(?:[\w:<>,@&]+)\s+(\w+)\s*\([^;]*\)\s*(?:const|override|property|final|\s)*(?:\{|$)/);
    const binding = line.match(/\bBindEventIds\b\s*(?:=\s*)?(.+)/);
    const add = (type: NodeType, name: string, parent: string, summary: string) => {
      const id = symbolNodeId(type,name,relativePath);
      store.addNode({ id,type,name,path:relativePath,system,language:"AngelScript",summary,metadata:{line:i+1,indexer:"lexical",verified:false} });
      store.addEdge({from:parent,to:id,type:"DECLARES",metadata:{line:i+1}});
      return id;
    };
    if (klass) {
      owner = add(klass[1] === "class" ? "Class" : klass[1] === "struct" ? "Struct" : "Enum",klass[2]!,file.id,line.trim());
      if (klass[3]) {
        const parentId = add("Class",klass[3],file.id,`Referenced parent ${klass[3]}`);
        store.addEdge({from:owner,to:parentId,type:"INHERITS",metadata:{line:i+1,unresolved:true}});
      }
    } else if (func && !/^(if|for|while|switch|return)$/.test(func[1]!)) add("Function",func[1]!,owner,line.trim());
    if (binding) {
      const id = add("Property","BindEventIds",owner,lines.slice(i,Math.min(i+4,lines.length)).join(" ").slice(0,800));
      for (const value of binding[1]!.matchAll(/\b\d{4,}\b/g)) {
        const signalId = symbolNodeId("Variable",`signal.${value[0]}`,"signals");
        store.addNode({id:signalId,type:"Variable",name:`signal.${value[0]}`,path:relativePath,system,language:"AngelScript",summary:`Signal binding ${value[0]}`,metadata:{line:i+1,indexer:"lexical"}});
        store.addEdge({from:id,to:signalId,type:"DEPENDS_ON",metadata:{line:i+1}});
      }
    }
  }
}
