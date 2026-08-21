declare module './core/world' {
    interface Entity {
        health?: Health;
        shieldTimer?: ShieldTimer;
        wavesReported?: true;
        legacyFlag?: true;
    }
}
