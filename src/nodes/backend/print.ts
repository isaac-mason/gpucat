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

/** The largest finite f32 and f16. */
const FLOAT_MAX = { f32: 3.4028234663852886e38, f16: 65504 };

/** `value` rounded to the nearest f16, ties to even, subnormals kept. Overflows to ±Infinity as f32 rounding does. */
function f16Round(value: number): number {
    const a = Math.abs(value);
    if (!Number.isFinite(a) || a === 0) return value;
    if (a >= 65520) return Math.sign(value) * Infinity;
    let e = Math.max(Math.floor(Math.log2(a)), -14);
    if (e > -14 && 2 ** e > a) e--;
    if (2 ** (e + 1) <= a) e++;
    const quantum = 2 ** (e - 10);
    const q = a / quantum;
    const f = Math.floor(q);
    const n = q - f > 0.5 || (q - f === 0.5 && f % 2 === 1) ? f + 1 : f;
    return Math.sign(value) * n * quantum;
}

/**
 * A float literal both WGSL and GLSL ES 3.00 parse back to the same `type` value as `value` rounds to: the fewest
 * significant digits that round-trip, always with a `.` in the mantissa (`2.0`, `0.083333336`, `1.0e+21`) and `-0.0`
 * keeping its sign. A bare `1` or `1e21` would read as an integer in GLSL, which has no implicit conversion, and JS's own
 * `1e+21` spelling with `.0` appended is no literal at all. Callers add any suffix (`h`).
 *
 * Throws on NaN and ±Infinity, which no shader literal spells, and on a value that rounds past the type's largest finite
 * value: printed at its shortest, even the f32 maximum overflows in some compilers, so the search checks each candidate.
 */
export function floatLiteral(value: number, type: 'f32' | 'f16' = 'f32'): string {
    const round = type === 'f32' ? Math.fround : f16Round;
    const target = round(value);
    if (!Number.isFinite(target)) {
        throw new Error(
            Number.isFinite(value)
                ? `[gpucat] ${value} is beyond the largest ${type}, ${FLOAT_MAX[type]}`
                : `[gpucat] ${value} has no ${type} literal: shaders spell no NaN or infinity`,
        );
    }
    if (target === 0) return Object.is(target, -0) ? '-0.0' : '0.0';
    for (let digits = 1; digits <= 17; digits++) {
        const candidate = target.toExponential(digits - 1);
        const parsed = Number(candidate);
        if (round(parsed) === target && Math.abs(parsed) <= FLOAT_MAX[type]) return spellFloat(candidate);
    }
    throw new Error(`[gpucat] no ${type} literal round-trips ${value}`);
}

/** `1.25e+2` as `125.0`, `1e+21` as `1.0e+21`: plain decimals where JS prints them so, an exponent otherwise. */
function spellFloat(exponential: string): string {
    const [mantissa, exponent] = exponential.split('e') as [string, string];
    const e = Number(exponent);
    if (e >= -6 && e <= 15) {
        const plain = `${Number(exponential)}`;
        return plain.includes('.') ? plain : `${plain}.0`;
    }
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${e < 0 ? '-' : '+'}${Math.abs(e)}`;
}

/** An i32 literal's digits, for a value already whole and in range. The smallest i32 can't be written as `-` applied
 *  to `2147483648`, which overflows first, so WGSL spells it as a conversion of the abstract integer. */
export function i32LiteralWgsl(value: number): string {
    if (!Number.isFinite(value)) throw new Error(`[gpucat] ${value} has no i32 literal`);
    const v = Math.trunc(value);
    return v === -2147483648 ? 'i32(-2147483648)' : `${v}i`;
}

/** A u32 literal's digits, for a value already whole and in range. */
export function u32Literal(value: number): string {
    if (!Number.isFinite(value)) throw new Error(`[gpucat] ${value} has no u32 literal`);
    return `${Math.trunc(value)}u`;
}

/** Whether a literal printed for `value` starts with a minus, binding as a unary expression. */
export function isNegativeLiteral(value: number): boolean {
    return value < 0 || Object.is(value, -0);
}
