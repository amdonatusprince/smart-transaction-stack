import { Commitment, Connection } from "@solana/web3.js";

export function createConnection(rpcUrl: string, commitment: Commitment = "confirmed") {
  return new Connection(rpcUrl, commitment);
}

export async function getRpcHealth(connection: Connection) {
  const [genesisHash, version, processedSlot, confirmedBlockhash] = await Promise.all([
    connection.getGenesisHash(),
    connection.getVersion(),
    connection.getSlot("processed"),
    connection.getLatestBlockhash("confirmed")
  ]);

  return {
    genesisHash,
    version,
    processedSlot,
    confirmedBlockhash
  };
}
