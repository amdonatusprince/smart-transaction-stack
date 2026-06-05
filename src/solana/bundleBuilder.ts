import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import bs58 from "bs58";
import type { BuiltBundle, FaultMode } from "../types/domain.js";

const MEMO_PROGRAM_ID = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

export interface BuildBundleInput {
  connection: Connection;
  payer: Keypair;
  tipAccount: string;
  tipLamports: number;
  memo: string;
  faultMode?: FaultMode;
  blockhashOverride?: string;
  lastValidBlockHeightOverride?: number;
}

export async function buildMemoTipBundle(input: BuildBundleInput): Promise<BuiltBundle> {
  const latest = input.blockhashOverride
    ? {
        blockhash: input.blockhashOverride,
        lastValidBlockHeight: input.lastValidBlockHeightOverride ?? 0
      }
    : await input.connection.getLatestBlockhash("confirmed");

  const instructions: TransactionInstruction[] = [];
  if (input.faultMode === "compute-exceeded") {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }));
  }

  instructions.push(
    new TransactionInstruction({
      keys: [
        {
          pubkey: input.payer.publicKey,
          isSigner: true,
          isWritable: false
        }
      ],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(input.memo)
    })
  );

  instructions.push(
    SystemProgram.transfer({
      fromPubkey: input.payer.publicKey,
      toPubkey: new PublicKey(input.tipAccount),
      lamports: input.tipLamports
    })
  );

  const message = new TransactionMessage({
    payerKey: input.payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([input.payer]);

  return {
    encodedTransactions: [Buffer.from(tx.serialize()).toString("base64")],
    signatures: [bs58.encode(tx.signatures[0])],
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    tipLamports: input.tipLamports,
    tipAccount: input.tipAccount
  };
}

export async function simulateBundleTransaction(connection: Connection, encodedTx: string) {
  const txBytes = Buffer.from(encodedTx, "base64");
  const tx = VersionedTransaction.deserialize(txBytes);
  return connection.simulateTransaction(tx, {
    commitment: "confirmed",
    replaceRecentBlockhash: false,
    sigVerify: false
  });
}
