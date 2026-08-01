use anchor_lang::prelude::*;
use solana_sha256_hasher::hash as sha256_hash;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("AAbKiRpmY5jYfC37DuQ9aTsWnNqxZXLe4fvyGSb3YS1F");

#[program]
pub mod htlc {
    use super::*;

    pub fn lock(
        ctx: Context<Lock>,
        swap_id: [u8; 32],
        amount: u64,
        hashlock: [u8; 32],
        timelock: i64,
    ) -> Result<()> {
        require!(amount > 0, HtlcError::AmountZero);
        let now = Clock::get()?.unix_timestamp;
        require!(timelock > now, HtlcError::TimelockPast);

        let s = &mut ctx.accounts.swap;
        s.sender = ctx.accounts.sender.key();
        s.receiver = ctx.accounts.receiver.key();
        s.mint = ctx.accounts.mint.key();
        s.amount = amount;
        s.hashlock = hashlock;
        s.timelock = timelock;
        s.claimed = false;
        s.refunded = false;
        s.bump = ctx.bumps.swap;
        s.vault_bump = ctx.bumps.vault;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.sender_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(Locked { swap_id, sender: s.sender, receiver: s.receiver, mint: s.mint, amount, hashlock, timelock });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, swap_id: [u8; 32], preimage: Vec<u8>) -> Result<()> {
        let s = &mut ctx.accounts.swap;
        require!(!s.claimed && !s.refunded, HtlcError::AlreadyDone);
        let h = sha256_hash(&preimage);
        require!(h.to_bytes() == s.hashlock, HtlcError::BadPreimage);
        s.claimed = true;

        let seeds: &[&[u8]] = &[b"vault", swap_id.as_ref(), &[s.vault_bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.receiver_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            s.amount,
        )?;
        emit!(Claimed { swap_id, preimage });
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, swap_id: [u8; 32]) -> Result<()> {
        let s = &mut ctx.accounts.swap;
        require!(!s.claimed && !s.refunded, HtlcError::AlreadyDone);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= s.timelock, HtlcError::TooEarly);
        s.refunded = true;

        let seeds: &[&[u8]] = &[b"vault", swap_id.as_ref(), &[s.vault_bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.sender_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            s.amount,
        )?;
        emit!(Refunded { swap_id });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct Lock<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: doar stocat ca pubkey receiver (LP); nu semneaza la lock
    pub receiver: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Swap::SIZE,
        seeds = [b"swap", swap_id.as_ref()],
        bump
    )]
    pub swap: Account<'info, Swap>,
    #[account(
        init,
        payer = payer,
        seeds = [b"vault", swap_id.as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = sender_ata.owner == sender.key() @ HtlcError::BadAta,
        constraint = sender_ata.mint == mint.key() @ HtlcError::BadAta
    )]
    pub sender_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct Claim<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"swap", swap_id.as_ref()], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(mut, seeds = [b"vault", swap_id.as_ref()], bump = swap.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = receiver_ata.owner == swap.receiver @ HtlcError::BadAta,
        constraint = receiver_ata.mint == swap.mint @ HtlcError::BadAta
    )]
    pub receiver_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct Refund<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"swap", swap_id.as_ref()], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(mut, seeds = [b"vault", swap_id.as_ref()], bump = swap.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = sender_ata.owner == swap.sender @ HtlcError::BadAta,
        constraint = sender_ata.mint == swap.mint @ HtlcError::BadAta
    )]
    pub sender_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Swap {
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hashlock: [u8; 32],
    pub timelock: i64,
    pub claimed: bool,
    pub refunded: bool,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Swap {
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 32 + 8 + 1 + 1 + 1 + 1;
}

#[event]
pub struct Locked {
    pub swap_id: [u8; 32],
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hashlock: [u8; 32],
    pub timelock: i64,
}
#[event]
pub struct Claimed {
    pub swap_id: [u8; 32],
    pub preimage: Vec<u8>,
}
#[event]
pub struct Refunded {
    pub swap_id: [u8; 32],
}

#[error_code]
pub enum HtlcError {
    #[msg("amount must be > 0")]
    AmountZero,
    #[msg("timelock must be in the future")]
    TimelockPast,
    #[msg("swap already claimed or refunded")]
    AlreadyDone,
    #[msg("preimage does not match hashlock")]
    BadPreimage,
    #[msg("refund not allowed before timelock")]
    TooEarly,
    #[msg("token account mint/owner mismatch")]
    BadAta,
}
