declare module "jito-ts/dist/sdk/block-engine/searcher" {
  export function searcherClient(url: string, authKeypair?: unknown, grpcOptions?: unknown): {
    getNextScheduledLeader(): Promise<unknown>;
    getConnectedLeaders(): Promise<unknown>;
    getTipAccounts(): Promise<unknown>;
    sendBundle(bundle: unknown): Promise<unknown>;
  };
}
