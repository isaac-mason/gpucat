export declare class Graph {
    maxPoints: number;
    lines: Record<string, {
        path: SVGPathElement;
        color: string;
        points: number[];
    }>;
    limit: number;
    limitIndex: number;
    domElement: SVGSVGElement;
    constructor(maxPoints?: number);
    addLine(id: string, color: string): void;
    addPoint(lineId: string, value: number): void;
    resetLimit(): void;
    update(): void;
}
