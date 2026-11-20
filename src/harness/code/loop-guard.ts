import { parse, type Node } from "acorn";
import { simple } from "acorn-walk";

/** The name of the function the instrumented code calls at the top of every loop iteration. */
export const GUARD_NAME = "__guard";

/** The wrapper the model's code runs inside: the body of an async function. */
const PREFIX = "(async function agentCode() {\n";
const SUFFIX = "\n})";

/** The model's code wrapped and instrumented, ready to evaluate. */
export interface PreparedCode {
  /** An expression that evaluates to the async function. */
  readonly source: string;
  /** Lines added before the model's first line; subtract from error line numbers. */
  readonly lineOffset: number;
}

/** A syntax error in the model's code, with the line number in the model's own numbering. */
export class CodeSyntaxError extends Error {
  readonly line: number | null;

  constructor(message: string, line: number | null) {
    super(message);
    this.name = "SyntaxError";
    this.line = line;
  }
}

type LoopNode = Node & { body: Node };

/**
 * Wraps the model's code as the body of an async function and inserts a guard call at the top of
 * every loop body.
 *
 * A synchronous infinite loop can never be interrupted from outside in JavaScript; the guard lets it
 * stop itself when the call is cancelled, times out, or blocks the event loop too long (which would
 * freeze the bot and get it kicked).
 *
 * @throws CodeSyntaxError when the code does not parse.
 */
export function prepareCode(code: string): PreparedCode {
  const wrapped = `${PREFIX}${code}${SUFFIX}`;
  let ast: Node;
  try {
    ast = parse(wrapped, { ecmaVersion: "latest", sourceType: "script", locations: true });
  } catch (error) {
    const location = (error as { loc?: { line: number } }).loc;
    const line = location === undefined ? null : location.line - 1;
    const message = error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)$/, "") : String(error);
    throw new CodeSyntaxError(line === null ? message : `${message} (line ${line})`, line);
  }
  const inserts: { at: number; text: string }[] = [];
  const guardLoop = (node: Node): void => {
    const body = (node as LoopNode).body;
    if (body.type === "BlockStatement") {
      inserts.push({ at: body.start + 1, text: `${GUARD_NAME}();` });
    } else {
      inserts.push({ at: body.start, text: `{${GUARD_NAME}();` }, { at: body.end, text: "}" });
    }
  };
  simple(ast, {
    ForStatement: guardLoop,
    ForInStatement: guardLoop,
    ForOfStatement: guardLoop,
    WhileStatement: guardLoop,
    DoWhileStatement: guardLoop,
  });
  // Apply from the end so earlier offsets stay valid; ties keep visit order, so inner braces close first.
  const ordered = inserts
    .map((insert, index) => ({ ...insert, index }))
    .sort((a, b) => b.at - a.at || a.index - b.index);
  let source = wrapped;
  for (const insert of ordered) {
    source = source.slice(0, insert.at) + insert.text + source.slice(insert.at);
  }
  return { source, lineOffset: 1 };
}
