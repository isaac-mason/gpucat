declare global {
    interface Scheduler {
        yield(): Promise<void>;
    }
    var scheduler: Scheduler | undefined;
}
export declare function yieldToMain(): Promise<void>;
