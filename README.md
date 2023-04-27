[Arcade.xyz](https://docs.arcade.xyz/docs/faq) facilitates trustless borrowing, lending, and escrow of NFT assets on EVM blockchains. This repository contains the core contracts that power the protocol, written in Solidity.

# Relevant Links

- 🌐 [Website](https://www.arcade.xyz) - Our app website, with a high-level overview of the project.
- 📝 [Usage Documentation](https://docs.arcade.xyz) - Our user-facing documentation for Arcade and the Pawn Protocol.
- 💬 [Discord](https://discord.gg/arcadexyz) - Join the Arcade community! Great for further technical discussion and real-time support.
- 🔔 [Twitter](https://twitter.com/arcade_xyz) - Follow us on Twitter for alerts and announcements.

# Overview of Contracts

See natspec for technical detail.

## Custody

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

## Verification

### ItemsVerifier

A contract that parses a payload of calldata and a target AssetVault, and decodes the payload in order to use it
for logic proving or disproving defined predicates about the vault. The ItemsVerifier decodes the calldata
as a list of required items the vault must hold in order for its predicates to pass. In the future, other contracts
implementing `ISignatureVerifier` can support other calldata formats and associated validation logic.

## Loan Lifecycle

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

Only the holder of the `LenderNote` can claim defaulted collateral for a different loan. When a loan is active and secured by an AssetVault, only the holder of the `BorrowerNote` can access utility for the collateralized assets using the vault's `call` function.

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

The fee controller is a contract containing functions that return values, in basis points, for assessed protocol
fees at different parts of the loan lifecycle. The fee amounts can be updated by the contract owner.

## Version 1

This is version 2 of the protocol. Version 1 of the protocol can be found [here](https://github.com/Non-fungible-Technologies/pawnfi-contracts).

## Breaking Changes from V1

- Creating bundles via the old `AssetWrapper` contract is no longer supported. Each borrower using a bundle should deploy their own vault contract using the `VaultFactory` to create a new bundle.
- `AssetVault` contracts do not support the `deposit{ETH,ERC20,ERC721,ERC1155}` methods from `AssetWrapper` for depositing assets. Deposits are made by transferring asset ownership to the vault.
- `AssetVaults` do not support the `withdraw` method from `AssetWrapper`. Every asset held by the vault must be withdrawn individually using the `withdraw{ETH,ERC20,ERC721,ERC1155}` functions. Each withdraw must specify the particular asset, since the vault does not track what assets it owns - this must be done off-chain. Owners must call `enableWithdraw` to enable the withdrawal methods on an asset vault. Vaults are non-transferrable with withdraw enabled.
- Signed terms must now contain a `deadline`, `interestRate`, `collateralAddress`, and `collateralId` field. The `interest` field is no longer supported.
- A signature can only be for a specific side of a loan - borrowing or lending. This defined by the `side` field in the signature. The field is an enum where `0` represents borrowing and `1` represents lending.
- A signature must also contain a `nonce`, a unique ID preventing signature re-use. The nonce must be in the signature payload and provided in `initializeLoan`.
- The typehash for signatures has changed to reflecting these new fields: see `_TOKEN_ID_TYPEHASH` in OriginationController.sol.
- Any repayment functions now take `loanId` as parameters instead of the appropriate note IDs. Note that in V2 these values are guaranteed to be the same.
- `PunkRouter` is no longer supported. CryptoPunks should be directly transferred to asset vaults for deposits.

# Privileged Roles and Access

The Arcade.xyz lending protocol has myriad functionality available to contract owners. This functionality represents a tradeoff between immutability, operational security, and recoverability in the case of exploit. All Arcade.xyz lending protocol contracts are non-upgradeable.

- `CallWhitelist.sol` is `Ownable` and has a defined owner, who can update a whitelist of allowed calls. This whitelist is global to every `AssetVault` deployed through the `VaultFactory`. In plain terms, the `CallWhitelist` owner has the ability to change the allowed functions an `AssetVault` can call. In practice, ownership follows the stated ownership policy above.
- `VaultFactory.sol` contains no privileged roles or functionality.
- `FeeController.sol` is `Ownable` and has a defined owner, who can update the protocol fees. In practice, this contract may be administered by an internal Arcade.xyz team without external signers, since it defines business logic around fees and has limited functionality. Internal constants define maximum fees that the protocol can set, preventing an attack whereby funds are drained via setting fees to 100%. Note that `LoanCore.sol` can switch out to a different FeeController entirely.
- `LoanCore.sol` is `AccessControl` and has a number of defined access roles:
  - The `ORIGINATOR_ROLE` is the only role allowed to access any functions which originate loans. In practice this role is granted to another smart contract, `OriginationController.sol`, which performs necessary checks and validation before starting loans.
  - The `REPAYER_ROLE` is the only role allowed to access any functions which affect the loan lifecycle of currently active loans (repayment or default claims). In practice this role is granted to another smart contract, `RepaymentController.sol`, which performs necessary checks, calculations and validation before starting loans.
  - The `FEE_CLAIMER_ROLE` is the only role allowed to update references to the `FeeController`, and claim any accumulated protocol fees. In practice this role will be assigned to an internal multisig, since withdrawing accumulated fees is a regular aspect of protocol operation.
- `OriginationController.sol` is `AccessControl` and specifies an `ADMIN_ROLE` and a `WHITELIST_MANAGER_ROLE`. The latter role can update the principal currency, collateral, and verifier whitelist. The `ADMIN_ROLE` can grant or revoke the whitelist manager role.
- `PromissoryNote.sol` is `Ownable`, and the owner has exclusive permission to initialize the contract with a reference to an address which is allowed to mint and burn note tokens. In practice, this permission will be granted to `LoanCore.sol`. Since `initialize` is called on deployment and can only be called once, in practice, the owner will be the deployer.
