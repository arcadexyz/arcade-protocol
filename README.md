[Arcade.xyz](https://docs.arcade.xyz/docs/faq) is a platform for autonomous borrowing, lending, and escrow of NFT collateral on EVM blockchains. This repository contains the core contracts that power the protocol, written in Solidity.

# Relevant Links

- 🌐 [Website](https://www.arcade.xyz) - UI to the Arcade Lending Protocol, hosted by Arcade.xyz.
- 📝 [Usage Documentation](https://docs.arcade.xyz) - User-facing documentation for the Arcade Lending Protocol.
- 🐛 [Bug Bounty](https://immunefi.com/bounty/arcade/) - Security discloure and bounty program for the Arcade Lending Protocol.
- 💬 [Discord](https://discord.gg/arcadexyz) - Join the Arcade.xyz community! Great for further technical discussion and real-time support.
- 🔔 [Twitter](https://twitter.com/arcade_xyz) - Follow us on Twitter for alerts, announcements, and alpha.

# Overview of Contracts

### ___See natspec for technical detail.___


The Arcade Lending protocol's smart contracts can be grouped into three main categories:
- __Core Lending__: These smart contracts define the core lending protocol mechanics. The main features implemented include collateral escrow, the loan lifecycle state machine, on-chain storage of loan information, and protocol invariants.
- __Vaults__: The Asset Vault is a smart contract, whose ownership is tracked by an NFT, that can be used to bundle multiple items of collateral for a single loan. Vaults also provide additional utility for escrowed assets, such as delegation.
- __Verifiers__: The Arcade Lending Protocol uses a flexible, predicate-based ruleset for governing mutual agreement to lending terms when originating a loan. Counterparties can sign payloads, targeted towards specific verifiers, that can run custom logic express rules under which loans can be originated.

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
the borrower. Loans can also be initialized with an ERC721 Permit message for collateral, removing the need for
a prior approval transaction from the borrower for assets which support `permit`.

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

A contract that parses a payload of calldata and a target AssetVault, and decodes the payload in order to use it
for logic proving or disproving defined predicates about the vault. The ItemsVerifier decodes the calldata
as a list of required items the vault must hold in order for its predicates to pass. In the future, other contracts
implementing `ISignatureVerifier` can support other calldata formats and associated validation logic.

The following verifier extensions have been implemented:

- `ArtBlocksVerifier.sol` can be used to specify project-specific collection-wide offers for ArtBlocks assets, which use a shared contract.
- `CollectionWideOfferVerifier.sol` allows lenders to sign offers against any `tokenId` of a particular ERC721 token. In addition, the signature is agnostic to whether that asset is escrowed directly or is escrowed within a vault.
- `PunksVerifier.sol` allows collection-wide offers on CryptoPunks.
- `UnvaultedItemsVerifier.sol` allows counterparties to propose collection-wide offers on assets that will be escrowed directly, without a vault.

## Metadata

The Arcade protocol contains three contracts that follow the ERC721 NFT standard: the Borrower Note and Lender Note (both instances of `PromissoryNote.sol`), and the Vault Factory. In all cases, the NFT contracts use a `tokenUri` implementation that queries an external, descriptor contract for a given token ID's URI. This allows more easy updates of image metadata and changes to token-based URI schemes. The current descriptor contracts are implemented:

- `StaticURIDescriptor.sol` contains a `tokenUri` function that returns the same URI value for any given tokenId.
- `BaseURIDescriptor.sol` contains a `tokenUri` function that returns an incrementing tokenId appended to a base URI path. This allows a `<base uri>/<token id>` URI scheme which allows unique images per token ID.

## Migrations

This repo implements a number of smart contracts that enable migration from other lending protocols to Arcade V3. All migration (or "rollover") contracts use the same settlement mechanism: initially, a flash loan is taken to repay an open loan, with a loan using the same collateral instantly opened on Arcade V3. Funding from the new loan can be used to repay the old loan from the source protocol. This allows capital-efficient adoption of the Arcade V3 protocol for those currently with active borrows against their NFTs.

Two source protocol migrations have been implemented:

- `V2ToV3Rollover.sol` and `V2ToV3RolloverWithItems.sol` allow migrations from the Arcade V2 protocol to Arcade V3.
- `LP1Migration.sol` and `LP1MigrationWithItems.sol` allow migrations from NFTfi loans to Arcade V3.

In both cases, the "with items" version of the smart contract allows the borrower to provide an items-based signature from a lender, as opposed to a vault based signature.

## Version 2

This is version 3 of the protocol. Version 2 of the protocol can be found [here](https://github.com/Non-fungible-Technologies/v2-contracts).

# Privileged Roles and Access

The Arcade Lending Protocol is an immutable, non-upgradeable protocol: there defined roles below specify the entire scope of current and future control any organization may have over the operation of the protocol. These roles are designed such that operational responsibility can be modularized and decentralized. In practice, the V3 protocol is owned by a set of governance smart contract that can execute the results of DAO votes.

- `CallWhitelist` assigns two privileged roles: an `ADMIN` and a `WHITELIST_MANAGER` role. Holders of the whitelist manager role can add or remove new function calls from the call whitelist, and perform analagous actions on the whitelist extension contracts. Holders of the admin role can grant and revoke the whitelist manager role.
- `VaultFactory.sol` assigns three privileged roles: an admin, a fee claimer, and a resource manager. The resource manager can change the descriptor contract of the VaultFactory NFT. The fee claimer can withdraw any mint fees collected by the contract. The admin can grant and revoke the fee claimer and resource manager roles.
- `FeeController.sol` is `Ownable` and has a defined owner, which can update the protocol fees. Internal constants define maximum fees that the protocol can set, preventing an attack whereby funds are drained via setting fees to 100%. Only the current owner can transfer ownership.
- `LoanCore.sol` is `AccessControl` and has a number of defined access roles:
  - The `ORIGINATOR` role is the only role allowed to access any functions which originate loans. In practice this role is granted to another smart contract, `OriginationController.sol`, which performs necessary checks and validation before starting loans. The `ADMIN` role can grant/revoke the `ORIGINATOR` role.
  - The `REPAYER` role is the only role allowed to access any functions which affect the loan lifecycle of currently active loans (repayment or default claims). In practice this role is granted to another smart contract, `RepaymentController.sol`, which performs necessary checks, calculations and validation before starting loans. The `ADMIN` role can grant/revoke the `REPAYER` role.
  - The `FEE_CLAIMER` role is the only role allowed claim accumulated protocol fees. The `ADMIN` role can grant/revoke the `FEE_CLAIMER` role.
  - The `AFFILIATE_MANAGER` role is the only role allowed to set affiliate splits for any fee collected during the loan lifecycle. The `ADMIN` role can grant/revoke the `AFFILIATE_MANAGER` role.
  - The `SHUTDOWN_CALLER` role is an emergency designation that allows holders to wind down core lending operations. In shutdown mode, loans can be repaid and collateral can be reclaimed, but new loans cannot be originated. Shutdown is irreversible.
- `OriginationController.sol` has two defined roles: the `ADMIN` role and a `WHITELIST_MANAGER`. The latter role can update the principal currency, collateral, and verifier whitelists. The `ADMIN` role can grant or revoke the `WHITELIST_MANAGER` role.
- `PromissoryNote.sol` has three defined roles: the `MINT/BURN` role allows the assigned address the ability to mint and burn tokens. For protocol operation, this would be `LoanCore`. The `RESOURCE_MANAGER` role allows the update of NFT metadata. The `ADMIN` role can grant/revoke the `MINT/BURN` role and `RESOURCE_MANAGER` role. In practice, after the note contract is initialized, the admin role is revoked in such a way it can never be regained.
- `BaseURIDescriptor.sol` and other descriptor contracts are `Ownable` and have a defined owner. The defined owner can update contract fields related to token URI and metadata, such as changing the base URI. Only the contract owner can transfer ownership. In practice, the owner of a descriptor contract should be the same address as the defined `RESOURCE_MANAGER` in the NFT contract that uses the descriptor.