[Arcade.xyz](https://docs.arcade.xyz/docs/faq) is a platform for autonomous borrowing, lending, and escrow of NFT collateral on EVM blockchains. This repository contains the core contracts that power the protocol, written in Solidity.

# Relevant Links

- 🌐 [Website](https://www.arcade.xyz) - UI to the Arcade Lending Protocol, hosted by Arcade.xyz.
- 📝 [Usage Documentation](https://docs.arcade.xyz) - User-facing documentation for the Arcade Lending Protocol.
- 🐛 [Bug Bounty](https://immunefi.com/bounty/arcade/) - Security disclosure and bounty program for the Arcade Lending Protocol.
- 💬 [Discord](https://discord.gg/arcadexyz) - Join the Arcade.xyz community! Great for further technical discussion and real-time support.
- 🔔 [Twitter](https://twitter.com/arcade_xyz) - Follow us on Twitter for alerts, announcements, and alpha.

# Overview of Contracts

### _This is version 4 of the lending protocol_

> Version 4 of the protocol has not yet been deployed to mainnet.

> Version 3 of the protocol can be found [here](https://github.com/arcadexyz/arcade-protocol/tree/v3.core.01).

> Version 2 of the protocol can be found [here](https://github.com/Non-fungible-Technologies/v2-contracts).

### **_See natspec for technical detail._**

The Arcade Lending protocol's smart contracts can be grouped into three main categories:

- **Core Lending**: These smart contracts define the core lending protocol mechanics. The main features implemented include collateral escrow, the loan lifecycle state machine, on-chain storage of loan information, and protocol invariants.
- **Vaults**: The Asset Vault is a smart contract, whose ownership is tracked by an NFT, that can be used to bundle multiple items of collateral for a single loan. Vaults also provide additional utility for escrowed assets, such as delegation.
- **Verifiers**: The Arcade Lending Protocol uses a flexible, predicate-based ruleset for governing mutual agreement to lending terms when originating a loan. Counterparties can sign payloads, targeted towards specific verifiers, that can run custom logic express rules under which loans can be originated.

## CoreLending

### LoanCore

The hub logic contract of the protocol, which contains storage information about loans (expressed by the `LoanData` struct),
and all required logic to update storage to reflect loan state, as well as handle both the intake and release of asset custody
during the loan lifecycle. Only specialized "controller" contracts have the ability to call LoanCore (see [OriginationController](#OriginationController)
and [RepaymentController](#RepaymentController)).

During active loans, the collateral asset is owned by LoanCore. LoanCore also collects fees for the protocol, which
can be withdrawn by the contract owner. LoanCore also tracks global signature nonces for required protocol signatures.

### PromissoryNote

An ERC721 representing obligation in an active loan. When a loan begins, two types of notes - a `BorrowerNote` and `LenderNote` -
are minted to the respective loan counterparties. When a loan ends via payoff or default, these notes are burned. The token IDs of each
note are synced with the unique ID of the loan.

Only the holder of the `LenderNote` can claim defaulted collateral for a different loan, or redeem a note which was already been repaid. When a loan is active and secured by an AssetVault, only the holder of the `BorrowerNote` can access utility for the collateralized assets using the vault's `call` function.

### OriginationController

The entry point contract for all new loans - this contract has exclusive permission to call functions which begin new loans
in `LoanCore`. The Origination Controller is responsible for validating the submitted terms of any new loan, parsing and
validating counterparty signatures to loan terms, and handling delegation of signing authority for an address.

When a loan begins, the Origination Controller collects the principal from the lender, and the collateral from
the borrower.

In addition to new loans, the Origination Controller is the entry point for rollovers, which use funds from a new loan
to repay an old loan and define new terms. In this case, the origination controller contract nets out funds
from the old and new loan, and collects any needed balance from the responsible party.

### RepaymentController

The repayment controller handles all lifecycle progression for currently active loans - this contract has exclusive
permission to call functions in `LoanCore` which repay loans, in whole or in part, or claim collateral on loan defaults.
This contract is responsible for validating repayments inputs, calculating owed amounts, and collecting owed amounts
from the relevant counterparty. This contract also contains a convenience function for calculating the total amount
due on any loan at a given time.

### FeeController

The fee controller is a contract containing functions that return values for assessed protocol
fees at different parts of the loan lifecycle. The fee amounts can be updated by the contract owner.

## Vaults

### VaultFactory

The Vault Factory is an ERC721 that tracks ownership of Asset Vault contracts (see OwnableERC721). Minting a new
VaultFactory token involves deploying a new AssetVault clone, and assigning the token's ID to the uint160 derived
from the clone's address.

Token ownership represents ownership of the underlying clone contract and can be transferred - however, to prevent
frontrunning attacks, any vault with withdrawals enabled cannot be transferred (see [AssetVault](#AssetVault)).

### AssetVault

The Asset Vault is a holding contract that functions as a bundling mechanism for multiple assets. Assets deposited
into the vault can only be withdrawn by the owner, and the vault contract itself's ownership is tracked by
an ERC721 (see [VaultFactory](#VaultFactory)).

AssetVaults are created with withdrawals disabled, and enabling withdrawals is an irreversible "unwrapping" operation.
Vaults with withdrawals enabled cannot be transferred. Deposits are always possible, by sending a given asset to the
vault's contract address. Asset Vaults can hold ETH, ERC20s, ERC721, ERC1155, and CryptoPunks.

The owner of a vault can also place an arbitrary `call` via the vault, in order to access utility derived from
NFTs held in the vault. Other contracts can delegate the ability to make calls. In practice, an Asset Vault custodied
by LoanCore delegates calling ability to the borrower, such that the borrower can access utility for a collateralized
vault. The protocol maintains a list of allowed calls (see [CallWhitelist](#CallWhitelist)).

### CallWhitelist

A global whitelist contract that all Asset Vaults refer to in order to allow/disallow certain calldata from being
used in the vault's `call` functionality. Transfer methods are blacklisted in order to prevent backdoor withdrawals from
vaults. The contract owner can choose to add or remove target addresses and function selectors from the list.

The extensions `CallWhitelistApprovals` and `CallWhitelistDelegation` add similar functionality for token approvals and [delegate.cash](https://delegate.cash/) delegations respectively. The `CallWhitelistAllExtensions` contract contains both aspects of mentioned functionality in addition to the base whitelist functionality.

## Verifiers

### ItemsVerifier

A contract that parses a payload of calldata (predicates) and a target AssetVault. The contract decodes the calldata in order to prove or disprove various characteristics of a vault. The ItemsVerifier decodes the calldata
as a list of required items the vault must hold in order for its predicates to pass. In the future, other contracts
implementing `ISignatureVerifier` can support other calldata formats and associated validation logic.

The following verifier extensions have been implemented:

- `ArtBlocksVerifier.sol` can be used to specify project-specific collection-wide offers for ArtBlocks assets, which use a shared contract.
- `CollectionWideOfferVerifier.sol` allows lenders to sign offers against any `tokenId` of a particular ERC721 token. In addition, the signature is agnostic to whether that asset is escrowed directly or is escrowed within a vault.
- `PunksVerifier.sol` allows collection-wide offers on CryptoPunks.
- `UnvaultedItemsVerifier.sol` allows counterparties to propose collection-wide offers on assets that will be escrowed directly, without a vault.

## Metadata

The Arcade protocol contains three contracts that follow the ERC721 NFT standard: the Borrower Note and Lender Note (both instances of `PromissoryNote.sol`), and the Vault Factory. In all cases, the NFT contracts use a `tokenURI` implementation that queries an external descriptor contract for a given token ID's URI. This allows more easy updates of image metadata and changes to token-based URI schemes. The current descriptor contracts are implemented:

- `StaticURIDescriptor.sol` contains a `tokenURI` function that returns the same URI value for any given tokenId.
- `BaseURIDescriptor.sol` contains a `tokenURI` function that returns an incrementing tokenId appended to a base URI path. This allows a `<base uri>/<token id>` URI scheme which allows unique images per token ID.

# Privileged Roles and Access

The Arcade Lending Protocol is an immutable, non-upgradeable protocol: there defined roles below specify the entire scope of current and future control any organization may have over the operation of the protocol. These roles are designed such that operational responsibility can be modularized and decentralized. In practice, the V3 protocol is owned by a set of governance smart contract that can execute the results of DAO votes.

- `CallWhitelist` assigns two privileged roles: an `ADMIN` and a `WHITELIST_MANAGER` role. Holders of the whitelist manager role can add or remove new function calls from the call whitelist, and perform analagous actions on the whitelist extension contracts. Holders of the admin role can grant and revoke the whitelist manager role.
- `VaultFactory.sol` assigns three privileged roles: an `ADMIN`, a `FEE_CLAIMER`, and a `RESOURCE_MANAGER`. The resource manager can change the descriptor contract of the VaultFactory NFT. The fee claimer can withdraw any mint fees collected by the contract. The admin can grant and revoke the fee claimer and resource manager roles.
- `FeeController.sol` is `Ownable` and has a defined owner, which can update the protocol fees. Internal constants define maximum fees that the protocol can set, preventing an attack whereby funds are drained via setting fees to 100%. Only the current owner can transfer ownership.
- `LoanCore.sol` is `AccessControl` and has a five defined access roles:
  - The `ORIGINATOR` role is the only role allowed to access any functions which originate loans. In practice this role is granted to another smart contract, `OriginationController.sol`, which performs necessary checks and validation before starting loans. The `ADMIN` role can grant/revoke the `ORIGINATOR` role.
  - The `REPAYER` role is the only role allowed to access any functions which affect the loan lifecycle of currently active loans (repayment or default claims). In practice this role is granted to another smart contract, `RepaymentController.sol`, which performs necessary checks, calculations and validation before starting loans. The `ADMIN` role can grant/revoke the `REPAYER` role.
  - The `FEE_CLAIMER` role is the only role allowed claim accumulated protocol fees. The `ADMIN` role can grant/revoke the `FEE_CLAIMER` role.
  - The `AFFILIATE_MANAGER` role is the only role allowed to set affiliate splits for any fee collected during the loan lifecycle. The `ADMIN` role can grant/revoke the `AFFILIATE_MANAGER` role.
  - The `SHUTDOWN_CALLER` role is an emergency designation that allows holders to wind down core lending operations. In shutdown mode, loans can be repaid and collateral can be reclaimed, but new loans cannot be originated. Shutdown is irreversible.
- `OriginationController.sol` has two defined roles: the `ADMIN` role and a `MIGRATION_MANAGER`. The latter role can pause v3->v4 migrations. The `ADMIN` role can grant or revoke the `MIGRATION_MANAGER` role.
- `OriginationConfiguration.sol` has two defined roles: the `ADMIN` role and a `WHITELIST_MANAGER`. The latter role can update the principal currency, collateral, and verifier whitelists. The `ADMIN` role can grant or revoke the `WHITELIST_MANAGER` role.
- `PromissoryNote.sol` has three defined roles: the `MINT/BURN` role allows the assigned address the ability to mint and burn tokens. For the lending protocol to operate correctly, this role must be granted to `LoanCore`. The `RESOURCE_MANAGER` role allows the update of NFT metadata. The `ADMIN` role can grant/revoke the `MINT/BURN` role and `RESOURCE_MANAGER` role. In practice, after the note contract is initialized, the admin role is revoked in such a way it can never be regained.
- `BaseURIDescriptor.sol` and other descriptor contracts are `Ownable` and have a defined owner. The defined owner can update contract fields related to token URI and metadata, such as changing the base URI. Only the contract owner can transfer ownership. In practice, the owner of a descriptor contract should be the same address as the defined `RESOURCE_MANAGER` in the NFT contract that uses the descriptor.

# Known Issues / Protocol Gotchas

### Token blacklists can affect loan operations

Some tokens, like USDC, include "blacklisting" functionality, where certain addresses can be added to the blacklist. When addresses are blacklisted, they cannot send or receive any amount of that token.

This can cause myriad issues for both the Arcade protocol and other autonomous, non-custodial on-chain protocols. Blacklisted tokens can often not be avoided (USDC being one of the most frequently used
tokens in on-chain protocols).

In the case where the Arcade Protocol itself were blacklisted, (`OriginationController` or `LoanCore`), the following functionality would be frozen:

- Borrowers would not be able to use `repay` or `forceRepay`, causing all active loans to go into default.
- Borrowers would also not be able to use rollovers to extend their loan's lifecycle.

In the case where one of a loan's counterparties were blacklisted, the following mitigations exist:

- A blacklisted borrower can repay a loan from a different address using `repay` or `forceRepay`. Collateral will still be returned to the original borrowing address.
- A blacklisted lender will not be able to receive tokens, meaning that `repay` will revert. In this case, the borrower can use `forceRepay`. In order to reclaim their tokens,
  the lender can send their lender note to a different, non-blacklisted address, and call `redeemNote` to receive their tokens.

### OriginationController approvals are high-trust

When the `OriginationController#approve` function is used, the address specified in the `signer` parameter has the ability to generate _any_ lending signature on behalf of the approving address (the `owner` address). Therefore, as long as proper token allowances are in place, the `signer` address can execute a transaction that enters the `owner` address into a loan, without any interaction with the `owner` itself.

The effect of that is that a malicious `signer` address could force a counterparty to enter into extremely disadvantageous terms, up to and including a total loss of all approved tokens (by forcing the `owner` address to lend their entire token allowance against "junk" collateral). Therefore, the trust assumptions for the `signer` address are extremely high, and malicious or compromised signers have multiple vectors to drain both tokens and NFTs from the `owner` address's wallet (as long as those tokens and NFTs have been previously approved to the Arcade Protocol).

The use case for `OriginationController#approve` is _not_ approval to untrusted sources: instead it should be used between two addresses controlled by the _same off-chain party_. For instance, a valid use case would be a hot/cold wallet setup, where the cold wallet is the source of lending funds, but the hot wallet provides signatures. The "cold" wallet in this scenario could be replaced by a smart contract, which cannot generate signatures itself.

If use cases were to ever arise where signing approval was given to an untrusted source (such as another smart contract), each owner who is delegating approval is cautioned to carefully manage their token and NFT approvals to the Arcade Protocol, and to treat any asset approved to the Arcade Protocol as also exposed to the untrusted signer.

### Nonces should be cancelled when potential collateral leaves a wallet

The OriginationController's signing flow separates counterparties along the following dimensions:

- The `borrower` vs. the `lender`
- The `caller` (the user initiating the on-chain transaction to originate a loan) vs. the `signer` (the user providing the signature when originating a loan)
- Self-signed signatures and "approved" signatures.

In some cases, open signatures for one of these roles (e.g. borrowing against an asset) can be used for other roles (e.g. to lend against the same asset). If users would like to borrow against an NFT, but then sell that NFT, they should cancel all open offers associated with that asset.

### `ArcadeItemsVerifier` predicates are independently evaluated

When `initializeLoanWithItems` is used, the counterparties provide a series of _predicates_: conditions that the collateral vault must fulfill in order for the loan
to be originated. The most simple predicate is a collection-wide offer (e.g., "the vault must hold at least one of token `0xABC`, of _any_ token ID").

When counterparties submit loans which use multiple predicates, it is important to note that in the currently implemented verifiers, predicates are _not deduplicated_ and are _independently evaluated_. This means that, if the above predicate were provided twice (in the exact same format), the verifier would _not_ require 2 independent tokens from `0xABC` - the same token would be able to fulfill _both_ predicates. In short, each predicate is not aware of any other predicates that have been evaluated, and a single token can fulfill multiple predicates. In general, lenders who are using predicates should be aware of this design and, if additional functionality such as deduplication is needed, write their own verifiers.

### `CallBlacklist` is non-comprehensive

The motivation of `CallBlacklist.sol` is provide guardrails for `AssetVault#call` - the vault utility feature of the Arcade Protocol. `AssetVault#call` is callable by the vault owner and allows a function to be called on behalf of the vault, as long as the function's target and selector is whitelisted by `CallWhitelistAllExtensions.sol`. `CallBlacklist.sol` is a set of function selectors that _cannot_ be added to the whitelist.

In general, whitelisted functions should provide utility, and should _never_ enable the caller to execute logic that will transfer the underlying asset out of the vault, burn it, or affect its value in any way. In order to protect against this, `CallBlacklist.sol` includes the standard transfer, approval, and burn functions for ERC20, ERC1155, ERC721, CryptoPunks, and SuperRare assets.

However, there are _many_ other functions, specific to certain smart contracts, which might affect asset ownership or value without being covered by the standard selectors. For instance, one can imagine an ERC20 token that has renamed its `burn` function to `destroy`. Since these functions may be unique to each target contract, they cannot comprehensively be covered by a global blacklist.

For these reason, while `CallBlacklist.sol` contains basic guardrails for the standard transfer functions, it should only be considered part of a defense-in-depth strategy, and _any_ new addition to the whitelist should be considered against these possible adverse outcomes:

- Could the new function result in the vault no longer "owning" the asset?
- Could the new function materially change the character of the asset (such as a burn?)
- Could the new function materially change the value of the asset?

When functions are whitelisted that _may_ change the character or value of the asset, lenders should consider those additional risks when choosing to accept that asset as collateral.
