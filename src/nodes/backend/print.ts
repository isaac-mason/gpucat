/**
 * backend/print.ts — expression spelling rules shared by the WGSL and GLSL emitters.
 *
 * Both target languages order their operators the same way, so one table serves both, but WGSL's
 * grammar also refuses some operands C precedence would accept ({@link wgslBinaryOperandMin}). An
 * emitter asks {@link exprPrec}-style questions of its own node kinds and calls {@link paren} to wrap
 * an operand only when the operand binds looser than the position it lands in. Nothing here touches
 * the node graph — it is string + precedence arithmetic only.
 */

/**
 * Binding strength of the top-level operator in an emitted expression string. An operand is
 * parenthesised only when its strength is below the minimum its position demands.
 *
 * `Lowest` is the safe answer for anything whose shape is not known (raw inline source), since it
 * parenthesises unconditionally.
 */
export const Prec = {
    Lowest: 0,
    Ternary: 1,
    LogicalOr: 2,
    LogicalAnd: 3,
    BitOr: 4,
    BitXor: 5,
    BitAnd: 6,
    Equality: 7,
    Relational: 8,
    Shift: 9,
    Additive: 10,
    Multiplicative: 11,
    Unary: 12,
    /** Literals, identifiers, calls, constructors, and `a.b` / `a[i]` chains — never need parens. */
    Postfix: 13,
} as const;

export type Prec = number;

const BINARY_PREC: Record<string, Prec> = {
    '||': Prec.LogicalOr,
    '&&': Prec.LogicalAnd,
    '|': Prec.BitOr,
    '^': Prec.BitXor,
    '&': Prec.BitAnd,
    '==': Prec.Equality,
    '!=': Prec.Equality,
    '<': Prec.Relational,
    '>': Prec.Relational,
    '<=': Prec.Relational,
    '>=': Prec.Relational,
    '<<': Prec.Shift,
    '>>': Prec.Shift,
    '+': Prec.Additive,
    '-': Prec.Additive,
    '*': Prec.Multiplicative,
    '/': Prec.Multiplicative,
    '%': Prec.Multiplicative,
};

/** Precedence of a binary operator, or `Lowest` for one not in the table (wrap it to be safe). */
export function binaryPrec(op: string): Prec {
    return BINARY_PREC[op] ?? Prec.Lowest;
}

/**
 * Minimum precedence each operand of a left-associative binary operator must have to appear unwrapped.
 *
 * The right operand is held one level higher than the left, so a same-precedence chain keeps the
 * grouping the graph actually describes: `a - (b - c)` and `a * (b / c)` retain their parentheses.
 * That is not cosmetic — float addition and multiplication are not associative, so dropping those
 * parens would change results.
 *
 * Comparison, equality, bitwise and logical operators additionally keep parens around an operand from
 * that same family, so `a == (b >= c)` and `(x && y) || z` do not collapse into chains whose grouping
 * a reader has to work out from the precedence table. Arithmetic operands stay bare, which is where
 * nearly all the noise was.
 */
export function binaryOperandMin(prec: Prec): [left: Prec, right: Prec] {
    if (prec <= Prec.Relational) return [Prec.Additive, Prec.Additive];
    return [prec, prec + 1];
}

/**
 * {@link binaryOperandMin} for WGSL, whose grammar takes only unary expressions as the operands of a
 * shift and of `&`, `|` and `^`: `a >> b * c` and `a & b + c` are syntax errors there, not lower
 * precedence, so any operand with a binary operator of its own is parenthesised.
 */
export function wgslBinaryOperandMin(prec: Prec): [left: Prec, right: Prec] {
    if (prec === Prec.Shift || prec === Prec.BitAnd || prec === Prec.BitOr || prec === Prec.BitXor) {
        return [Prec.Unary, Prec.Unary];
    }
    return binaryOperandMin(prec);
}

/** Wrap `expr` in parentheses if its top-level operator binds looser than the position requires. */
export function paren(expr: string, prec: Prec, min: Prec): string {
    return prec < min ? `(${expr})` : expr;
}

/**
 * Prefix unary operator applied to an already-emitted operand.
 *
 * The operand only needs wrapping below unary strength, with one extra case: an operand that itself
 * starts with the same symbol is parenthesised so `-` and `-` cannot paste into the `--` token GLSL
 * reads as a decrement.
 */
export function unary(op: '-' | '!', operand: string, prec: Prec): string {
    const wrapped = paren(operand, prec, Prec.Unary);
    return wrapped.startsWith(op) ? `${op}(${wrapped})` : `${op}${wrapped}`;
}

/** One labelled block of emitted source. */
export type Section = { title?: string; body: string };

/**
 * Join sections with a blank line between them, dropping the empty ones — heading included, so a
 * shader with no module-scope variables does not open on a comment announcing that it has none.
 */
export function joinSections(sections: Section[]): string {
    return sections
        .filter((s) => s.body.trim() !== '')
        .map((s) => (s.title === undefined ? s.body.trimEnd() : `${s.title}\n${s.body.trimEnd()}`))
        .join('\n\n');
}

/**
 * Shortest decimal spelling that round-trips to the same f32 as `value`.
 *
 * Shader float literals are parsed at f32, so printing a JavaScript number's full f64 decimal
 * expansion (`0.08333333333333333` for 1/12) adds 8 digits that the target cannot represent. This
 * finds the fewest significant digits that still land on the same f32 (`0.083333336`). Callers handle
 * whole numbers themselves — those already have a short exact form and a required `.0` suffix.
 */
export function shortestF32(value: number): string {
    if (!Number.isFinite(value)) return `${value}`;
    const target = Math.fround(value);
    for (let digits = 1; digits <= 9; digits++) {
        const candidate = target.toPrecision(digits);
        if (Math.fround(Number(candidate)) === target) return trimFloat(candidate);
    }
    return trimFloat(`${target}`);
}

/** Drop the trailing zeros `toPrecision` pads with (`0.30000` → `0.3`), keeping at least one decimal. */
function trimFloat(s: string): string {
    if (s.includes('e') || s.includes('E') || !s.includes('.')) return s;
    const trimmed = s.replace(/0+$/, '');
    return trimmed.endsWith('.') ? `${trimmed}0` : trimmed;
}
