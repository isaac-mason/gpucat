export type Listener<T extends unknown[]> = (...data: T) => void;
export type Unsubscribe = () => void;
export type Topic<T extends unknown[]> = {
    listeners: Set<Listener<T>>;
    add(handler: Listener<T>): Unsubscribe;
    remove(handler: Listener<T>): void;
    emit(...data: T): void;
    clear(): void;
};
export declare const topic: <T extends unknown[]>() => Topic<T>;
