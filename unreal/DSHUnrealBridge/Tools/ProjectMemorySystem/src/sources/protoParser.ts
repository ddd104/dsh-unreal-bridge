import path from "node:path";
import protobuf from "protobufjs";

export function parseProto(filePath: string, content: Buffer): {
  title: string;
  text: string;
  metadata: Record<string, unknown>;
} {
  const original = content.toString("utf8").replace(/^\uFEFF/, "");
  const parsed = protobuf.parse(original, { keepCase: true });
  const syntax = /^\s*syntax\s*=\s*["'](proto2|proto3)["']/m.exec(original)?.[1];
  const imports = parsed.imports ?? [];
  const declarations: string[] = [];
  const messages: string[] = [];
  const enums: string[] = [];
  const services: string[] = [];

  function visit(object: protobuf.ReflectionObject): void {
    const name = object.fullName.replace(/^\./, "");
    if (object instanceof protobuf.Type) {
      messages.push(name);
      declarations.push(`message ${name}`);
      for (const field of object.fieldsArray) {
        const type = field instanceof protobuf.MapField ? `map<${field.keyType}, ${field.type}>` : field.type;
        const rule = field.repeated ? "repeated " : field.required ? "required " : "";
        declarations.push(`  ${field.id}: ${rule}${type} ${field.name}`);
      }
      for (const oneof of object.oneofsArray) {
        declarations.push(`  oneof ${oneof.name}: ${oneof.oneof.join(", ")}`);
      }
    } else if (object instanceof protobuf.Enum) {
      enums.push(name);
      declarations.push(`enum ${name}`);
      for (const [valueName, number] of Object.entries(object.values)) {
        declarations.push(`  ${valueName} = ${number}`);
      }
    } else if (object instanceof protobuf.Service) {
      services.push(name);
      declarations.push(`service ${name}`);
      for (const method of object.methodsArray) {
        declarations.push(`  rpc ${method.name} (${method.requestStream ? "stream " : ""}${method.requestType}) returns (${method.responseStream ? "stream " : ""}${method.responseType})`);
      }
    }
    if (object instanceof protobuf.Namespace) {
      for (const child of object.nestedArray) visit(child);
    }
  }

  visit(parsed.root);
  const header = [
    syntax ? `syntax ${syntax}` : "",
    parsed.package ? `package ${parsed.package}` : "",
    ...imports.map((entry) => `import ${entry}`),
    ...declarations
  ].filter(Boolean).join("\n");
  return {
    title: parsed.package ? `Protocol ${parsed.package}` : path.basename(filePath),
    text: `${header}\n\n${original}`.trim(),
    metadata: { syntax, package: parsed.package, imports, messages, enums, services }
  };
}
