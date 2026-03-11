// declare scheduler.yield(), available in most modern browsers
declare global {
    interface Scheduler {
        yield(): Promise<void>;
    }
    // eslint-disable-next-line no-var
    var scheduler: Scheduler | undefined;
}

export function yieldToMain(): Promise<void> {
    // modern browsers: scheduler.yield() is the most efficient way to yield
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield();
    }
    // fallback: setTimeout with 0ms delay yields to the event loop
    return new Promise(resolve => setTimeout(resolve, 0));
}
