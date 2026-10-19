import ts from "typescript";

/** What stock claude-hud lets a person configure and draw, read from its `src/config.ts`. */
export interface ClaudeHudInventory {
  /** Every leaf setting of `DEFAULT_CONFIG` by dotted path (`display.showModel`, `gitStatus.enabled`); a list or a scalar is a leaf, a nested object is walked. */
  readonly settings: readonly string[];
  /** The members of the `HudElement` union: the lines `elementOrder` arranges. */
  readonly elements: readonly string[];
  /** The members of the `FirstLineSegment` union: the segments `projectLineOrder` arranges. */
  readonly firstLineSegments: readonly string[];
}

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

function leafPaths(literal: ts.ObjectLiteralExpression, prefix: readonly string[]): string[] {
  return literal.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return [];
    }
    const path = [...prefix, propertyName(property.name)];
    return ts.isObjectLiteralExpression(property.initializer) ? leafPaths(property.initializer, path) : [path.join(".")];
  });
}

function unionMembers(source: ts.SourceFile, typeName: string): string[] {
  const alias = source.statements.find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName);
  if (alias === undefined || !ts.isUnionTypeNode(alias.type)) {
    throw new Error(`claude-hud's config.ts has no union type named ${typeName}`);
  }
  return alias.type.types.flatMap((member) => (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : []));
}

/** Reads claude-hud's `src/config.ts` source text into its inventory. Fails loudly when the file no longer has the shapes the reader relies on, so a drifting upstream is noticed rather than silently under-read. */
export function readClaudeHudInventory(configSource: string): ClaudeHudInventory {
  const source = ts.createSourceFile("config.ts", configSource, ts.ScriptTarget.Latest, true);
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "DEFAULT_CONFIG");
  if (declaration?.initializer === undefined || !ts.isObjectLiteralExpression(declaration.initializer)) {
    throw new Error("claude-hud's config.ts has no DEFAULT_CONFIG object literal");
  }
  return {
    settings: leafPaths(declaration.initializer, []),
    elements: unionMembers(source, "HudElement"),
    firstLineSegments: unionMembers(source, "FirstLineSegment"),
  };
}
