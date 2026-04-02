export type Listener<T extends unknown[]> = (...data: T) => void;

export type Unsubscribe = () => void;

export type Topic<T extends unknown[]> = {
    listeners: Set<Listener<T>>;
    add(handler: Listener<T>): Unsubscribe;
    remove(handler: Listener<T>): void;
    emit(...data: T): void;
    clear(): void;
};

export const topic = <T extends unknown[]>(): Topic<T> => {
    return {
        listeners: new Set<Listener<T>>(),

        add(handler: Listener<T>): Unsubscribe {
            this.listeners.add(handler);

            return () => this.remove(handler);
        },

        remove(handler: Listener<T>): void {
            this.listeners.delete(handler);
        },

        emit(...data: T): void {
            for (const handler of this.listeners) {
                handler(...data);
            }
        },

        clear(): void {
            this.listeners.clear();
        },
    };
};
