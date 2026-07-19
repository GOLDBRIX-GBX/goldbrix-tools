// ============================================================
// GOLDBRIX · sol-htlc-cli.mjs · oglinda Solana a evm-htlc-cli.mjs
// Comenzi: events | claim | refund | balance
// Apelat de daemon prin solcli(). Iesire JSON pe stdout (ca EVM CLI).
// Cheia LP: primita ca array secret (din _load_solana_key in RAM), NU citita de pe disc aici.
// swap_id (model A): vine din intent prin daemon, NU reconstruit din enumerare.
// ============================================================
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const { AnchorProvider, Program, Wallet } = anchor;
const a = JSON.parse(process.argv[2]);

const RPC        = a.rpc || "https://api.mainnet-beta.solana.com";
const COMMITMENT = a.commitment || "finalized";   // lectia smoke-test: NU "confirmed" pt verdict
const PROGRAM_ID = new PublicKey(a.program);
const IDL_PATH   = a.idl || "/root/gbx-solana-htlc/htlc/target/idl/htlc.json";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function lpKeypair() {
  if (!a.lp_secret) throw new Error("lp_secret lipsa (array 64 bytes)");
  return Keypair.fromSecretKey(new Uint8Array(a.lp_secret));
}

const conn = new Connection(RPC, COMMITMENT);
const idl  = JSON.parse(readFileSync(IDL_PATH, "utf8"));

function makeProgram(kp) {
  const wallet = new Wallet(kp || Keypair.generate());
  const provider = new AnchorProvider(conn, wallet, { commitment: COMMITMENT });
  return new Program(idl, provider);
}

async function splBal(pubkeyStr) {
  try { return (await getAccount(conn, new PublicKey(pubkeyStr), COMMITMENT)).amount.toString(); }
  catch { return "0/none"; }
}

function pdas(swapIdBytes) {
  const [swapPda]  = PublicKey.findProgramAddressSync([Buffer.from("swap"),  Buffer.from(swapIdBytes)], PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(swapIdBytes)], PROGRAM_ID);
  return { swapPda, vaultPda };
}

let out = {};
try {
  // TRADE-1: every swap ever created, settled ones INCLUDED. "events" deliberately skips
  // claimed/refunded (the daemon only cares about live ones); the trade index needs exactly those.
  // Additive: the production path above is untouched.
  if (a.cmd === "all-swaps") {
    const program = makeProgram(null);
    const all = await program.account.swap.all();
    out = { swaps: all.map(it => ({
      swapAccount: it.publicKey.toBase58(),
      amount:   it.account.amount.toString(),
      hashlock: "0x" + Buffer.from(it.account.hashlock).toString("hex"),
      claimed:  it.account.claimed,
      refunded: it.account.refunded,
    })) };
  }
  else if (a.cmd === "events") {
    const program = makeProgram(null);
    const lp = a.receiver;
    const all = await program.account.swap.all();
    const events = [];
    for (const it of all) {
      const s = it.account;
      if (s.receiver.toBase58() !== lp) continue;
      if (s.claimed || s.refunded) continue;
      events.push({
        swapAccount: it.publicKey.toBase58(),
        sender:   s.sender.toBase58(),
        receiver: s.receiver.toBase58(),
        mint:     s.mint.toBase58(),
        amount:   s.amount.toString(),
        hashlock: "0x" + Buffer.from(s.hashlock).toString("hex"),
        timelock: s.timelock.toString(),
        claimed:  s.claimed,
        refunded: s.refunded,
      });
    }
    out = { events };
  }

  else if (a.cmd === "claim") {
    const kp = lpKeypair();
    const program = makeProgram(kp);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const preimage = Buffer.from(a.preimage.replace(/^0x/, ""), "hex");
    const { swapPda, vaultPda } = pdas(swapId);

    const h = "0x" + createHash("sha256").update(preimage).digest("hex");
    if (a.hashlock && h.toLowerCase() !== a.hashlock.toLowerCase())
      throw new Error("preimage nu corespunde hashlock (local guard)");

    const vaultBefore = await splBal(vaultPda.toBase58());
    const receiverAta = new PublicKey(a.receiver_ata);
    const sig = await program.methods
      .claim([...swapId], preimage)
      .accounts({ caller: kp.publicKey, swap: swapPda, vault: vaultPda,
        receiverAta, tokenProgram: TOKEN_PROGRAM })
      .signers([kp]).rpc({ commitment: COMMITMENT });
    const vaultAfter = await splBal(vaultPda.toBase58());

    out = { status: (vaultBefore !== "0/none" && vaultBefore !== "0" && (vaultAfter === "0/none" || vaultAfter === "0")) ? "0x1" : "0x0",
            sig, vault_before: vaultBefore, vault_after: vaultAfter };
  }

  else if (a.cmd === "refund") {
    const kp = lpKeypair();
    const program = makeProgram(kp);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const { swapPda, vaultPda } = pdas(swapId);
    const senderAta = new PublicKey(a.sender_ata);
    const sig = await program.methods
      .refund([...swapId])
      .accounts({ caller: kp.publicKey, swap: swapPda, vault: vaultPda,
        senderAta, tokenProgram: TOKEN_PROGRAM })
      .signers([kp]).rpc({ commitment: COMMITMENT });
    out = { status: "0x1", sig };
  }

  else if (a.cmd === "swap") {
    const program = makeProgram(null);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const { swapPda } = pdas(swapId);
    try {
      const s = await program.account.swap.fetch(swapPda);
      out = { swap: {
        swapAccount: swapPda.toBase58(), sender: s.sender.toBase58(), receiver: s.receiver.toBase58(),
        mint: s.mint.toBase58(), amount: s.amount.toString(),
        hashlock: "0x" + Buffer.from(s.hashlock).toString("hex"),
        timelock: s.timelock.toString(), claimed: s.claimed, refunded: s.refunded,
      }};
    } catch (e) { out = { swap: null }; }
  }

  else if (a.cmd === "prepare-lock") {
    const { Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } = await import("@solana/web3.js");
    const { getAssociatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const kp = lpKeypair();
    const program = makeProgram(kp);
    const userPk = new PublicKey(a.user_pubkey);
    const mint   = new PublicKey(a.mint);
    const swapId   = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const hashlock = Buffer.from(a.hashlock.replace(/^0x/, ""), "hex");
    const amount   = BigInt(a.amount);
    const timelock = BigInt(a.timelock);
    const { swapPda, vaultPda } = pdas(swapId);
    const senderAta = await getAssociatedTokenAddress(mint, userPk);
    const ix = await program.methods
      .lock([...swapId], new anchor.BN(amount.toString()), [...hashlock], new anchor.BN(timelock.toString()))
      .accounts({
        sender: userPk, payer: kp.publicKey, receiver: kp.publicKey,
        mint, swap: swapPda, vault: vaultPda, senderAta,
        tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = kp.publicKey;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
    tx.recentBlockhash = blockhash;
    tx.partialSign(kp);
    const txB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    out = {
      tx_b64: txB64, swap_id: "0x" + swapId.toString("hex"),
      hashlock: "0x" + hashlock.toString("hex"), blockhash, lastValidBlockHeight,
      vault: vaultPda.toBase58(), swap_account: swapPda.toBase58(),
      sender_ata: senderAta.toBase58(), lp_pubkey: kp.publicKey.toBase58(), amount: amount.toString(),
    };
  }

  else if (a.cmd === "submit-lock") {
    const { Transaction } = await import("@solana/web3.js");
    const raw = Buffer.from(a.tx_signed_b64, "base64");
    const tx = Transaction.from(raw);
    const sigs = tx.signatures.filter(s => s.signature !== null);
    if (sigs.length < 2) throw new Error("tx incomplet semnata: " + sigs.length + "/2");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, COMMITMENT);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const { vaultPda } = pdas(swapId);
    // verdict robust: tx confirmata cu err=null = succes; vault-ul se citeste cu retry (race RPC)
    let vaultBal = "0/none";
    for (let i = 0; i < 10; i++) {
      vaultBal = await splBal(vaultPda.toBase58());
      if (vaultBal !== "0/none" && vaultBal !== "0") break;
      await new Promise(r => setTimeout(r, 1500));
    }
    const st = await conn.getSignatureStatuses([sig]).catch(() => null);
    const txErr = st && st.value && st.value[0] ? st.value[0].err : "unknown";
    out = { status: (txErr === null) ? "0x1" : "0x0", sig, vault: vaultBal, txErr };
  }

  else if (a.cmd === "lock-sell") {
    // SELL: LP locheaza USDC pentru user (sender=payer=LP, receiver=user). Creeaza ATA user daca lipseste (LP plateste).
    const { Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } = await import("@solana/web3.js");
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const kp = lpKeypair();
    const program = makeProgram(kp);
    const userPk = new PublicKey(a.user_pubkey);
    const mint = new PublicKey(a.mint);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const hashlock = Buffer.from(a.hashlock.replace(/^0x/, ""), "hex");
    const amount = BigInt(a.amount);
    const timelock = BigInt(a.timelock);
    const { swapPda, vaultPda } = pdas(swapId);
    const lpAta = await getAssociatedTokenAddress(mint, kp.publicKey);
    const userAta = await getAssociatedTokenAddress(mint, userPk);
    const tx = new Transaction();
    if ((await splBal(userAta.toBase58())) === "0/none")
      tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, userAta, userPk, mint));
    const ix = await program.methods
      .lock([...swapId], new anchor.BN(amount.toString()), [...hashlock], new anchor.BN(timelock.toString()))
      .accounts({
        sender: kp.publicKey, payer: kp.publicKey, receiver: userPk,
        mint, swap: swapPda, vault: vaultPda, senderAta: lpAta,
        tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    tx.add(ix);
    tx.feePayer = kp.publicKey;
    const { blockhash } = await conn.getLatestBlockhash(COMMITMENT);
    tx.recentBlockhash = blockhash;
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, COMMITMENT);
    const vaultBal = await splBal(vaultPda.toBase58());
    out = { status: (vaultBal === amount.toString()) ? "0x1" : "0x0", sig,
            id: "0x" + swapId.toString("hex"), vault: vaultBal,
            user_ata: userAta.toBase58(), swap_account: swapPda.toBase58() };
  }

  else if (a.cmd === "prepare-claim") {
    // GASLESS CLAIM (sell): caller=user (Signer), feePayer=LP. LP partialSign -> user semneaza in browser -> submit-claim.
    const { Transaction } = await import("@solana/web3.js");
    const { getAssociatedTokenAddress } = await import("@solana/spl-token");
    const kp = lpKeypair();
    const program = makeProgram(kp);
    const userPk = new PublicKey(a.user_pubkey);
    const mint = new PublicKey(a.mint);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const preimage = Buffer.from(a.preimage.replace(/^0x/, ""), "hex");
    const { swapPda, vaultPda } = pdas(swapId);
    const receiverAta = await getAssociatedTokenAddress(mint, userPk);
    const ix = await program.methods.claim([...swapId], preimage)
      .accounts({ caller: userPk, swap: swapPda, vault: vaultPda, receiverAta, tokenProgram: TOKEN_PROGRAM })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = kp.publicKey;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
    tx.recentBlockhash = blockhash;
    tx.partialSign(kp);
    out = { tx_b64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
            blockhash, lastValidBlockHeight, receiver_ata: receiverAta.toBase58(),
            swap_account: swapPda.toBase58() };
  }

  else if (a.cmd === "submit-claim") {
    const { Transaction } = await import("@solana/web3.js");
    const tx = Transaction.from(Buffer.from(a.tx_signed_b64, "base64"));
    const sigs = tx.signatures.filter(s => s.signature !== null);
    if (sigs.length < 2) throw new Error("tx incomplet semnata: " + sigs.length + "/2");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, COMMITMENT);
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const { vaultPda } = pdas(swapId);
    out = { status: "0x1", sig, vault_after: await splBal(vaultPda.toBase58()) };
  }

  else if (a.cmd === "preimage") {
    // Extrage preimage-ul din tx-ul de claim al swap-ului (on-chain, trustless).
    // claim ix data = discriminator(8) + swap_id(32) + vec<u8> preimage (len u32 LE + bytes)
    const swapId = Buffer.from(a.swap_id.replace(/^0x/, ""), "hex");
    const { swapPda } = pdas(swapId);
    const sigs = await conn.getSignaturesForAddress(swapPda, { limit: 25 }, COMMITMENT);
    let found = null;
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const keys = tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys;
      for (const ix of tx.transaction.message.instructions) {
        const pid = keys[ix.programIdIndex];
        if (pid.toBase58 ? pid.toBase58() !== PROGRAM_ID.toBase58() : String(pid) !== PROGRAM_ID.toBase58()) continue;
        const data = Buffer.from(anchor.utils.bytes.bs58.decode(ix.data));
        if (data.length < 8 + 32 + 4) continue;
        const len = data.readUInt32LE(40);
        if (data.length < 44 + len) continue;
        const pre = data.slice(44, 44 + len);
        const h = "0x" + createHash("sha256").update(pre).digest("hex");
        if (a.hashlock && h.toLowerCase() !== a.hashlock.toLowerCase()) continue;
        found = { preimage: "0x" + pre.toString("hex"), hashlock: h, sig: s.signature };
        break;
      }
      if (found) break;
    }
    out = found || { preimage: null };
  }

  else if (a.cmd === "balance") {
    out = { balance: await splBal(a.account) };
  }

  else throw new Error("cmd necunoscut: " + a.cmd);

  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e.message || e) }));
  process.exit(0);
}
