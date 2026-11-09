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
export declare const Prec: {
    readonly Lowest: 0;
    readonly Ternary: 1;
    readonly LogicalOr: 2;
    readonly LogicalAnd: 3;
    readonly BitOr: 4;
    readonly BitXor: 5;
    readonly BitAnd: 6;
    readonly Equality: 7;
    readonly Relational: 8;
    readonly Shift: 9;
    readonly Additive: 10;
    readonly Multiplicative: 11;
    readonly Unary: 12;
    /** Literals, identifiers, calls, constructors, and `a.b` / `a[i]` chains — never need parens. */
    readonly Postfix: 13;
};
export type Prec = number;
/** Precedence of a binary operator, or `Lowest` for one not in the table (wrap it to be safe). */
export declare function binaryPrec(op: string): Prec;
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
export declare function binaryOperandMin(prec: Prec): [left: Prec, right: Prec];
/**
 * {@link binaryOperandMin} for WGSL, whose grammar takes only unary expressions as the operands of a
 * shift and of `&`, `|` and `^`: `a >> b * c` and `a & b + c` are syntax errors there, not lower
 * precedence, so any operand with a binary operator of its own is parenthesised.
 */
export declare function wgslBinaryOperandMin(prec: Prec): [left: Prec, right: Prec];
/** Wrap `expr` in parentheses if its top-level operator binds looser than the position requires. */
export declare function paren(expr: string, prec: Prec, min: Prec): string;
/**
 * Prefix unary operator applied to an already-emitted operand.
 *
 * The operand only needs wrapping below unary strength, with one extra case: an operand that itself
 * starts with the same symbol is parenthesised so `-` and `-` cannot paste into the `--` token GLSL
 * reads as a decrement.
 */
export declare function unary(op: '-' | '!', operand: string, prec: Prec): string;
/** One labelled block of emitted source. */
export type Section = {
    title?: string;
    body: string;
};
/**
 * Join sections with a blank line between them, dropping the empty ones — heading included, so a
 * shader with no module-scope variables does not open on a comment announcing that it has none.
 */
export declare function joinSections(sections: Section[]): string;
/**
 * A float literal both WGSL and GLSL ES 3.00 parse back to the same `type` value as `value` rounds to: the fewest
 * significant digits that round-trip, always with a `.` in the mantissa (`2.0`, `0.083333336`, `1.0e+21`) and `-0.0`
 * keeping its sign. A bare `1` or `1e21` would read as an integer in GLSL, which has no implicit conversion, and JS's own
 * `1e+21` spelling with `.0` appended is no literal at all. Callers add any suffix (`h`).
 *
 * Throws on NaN and ±Infinity, which no shader literal spells, and on a value that rounds past the type's largest finite
 * value: printed at its shortest, even the f32 maximum overflows in some compilers, so the search checks each candidate.
 */
export declare function floatLiteral(value: number, type?: 'f32' | 'f16'): string;
/** An i32 literal's digits, for a value already whole and in range. The smallest i32 can't be written as `-` applied
 *  to `2147483648`, which overflows first, so WGSL spells it as a conversion of the abstract integer. */
export declare function i32LiteralWgsl(value: number): string;
/** A u32 literal's digits, for a value already whole and in range. */
export declare function u32Literal(value: number): string;
/**
 * A numeric scalar literal converted as WGSL converts it, for folding `u32(-1i)` and the like into one literal. Float to
 * integer truncates and saturates, NaN giving 0; i32 and u32 reinterpret each other's bits; anything to a float is
 * that number, rounded when printed. The JS value alone would print `-1u`, which neither language accepts.
 */
export declare function convertScalarLiteral(value: number, from: string, to: string): number;
/** Whether a literal printed for `value` starts with a minus, binding as a unary expression. */
export declare function isNegativeLiteral(value: number): boolean;
