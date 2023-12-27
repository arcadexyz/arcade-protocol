# ✨ Arcade.xyz Lending Protocol V3.1 Audit Scope

Arcade.xyz is the first of its kind Web3 platform to enable liquid lending markets for NFTs. At Arcade.xyz, we think all assets will eventually become digitized and that NFTs represent a 0 to 1 innovation in storing value and ownership attribution for unique digital assets.

Arcade.xyz's focus is on building primitives, infrastructure, and applications enabling the growth of NFTs as an asset class. As such, the first product we released is an innovative peer to peer lending marketplace that allows NFT owners to unlock liquidity on baskets of NFTs on Ethereum. Lenders that hold stablecoins or ERC20 tokens can participate in a new source of DeFi yield by underwriting term loans collateralized by borrowers' NFTs.

Arcade.xyz is our end user application that strives to become the premier liquidity venue for NFTs, via a protocol for NFT collateralized loans with flexible terms. Today NFTs are largely digital representations of artwork and media content, however, our belief is that in the not so distant future NFTs will encompass digital rights, metaverse assets, and digital identity.

For more information about Arcade.xyz, please visit https://docs.arcadedao.xyz/docs.

## Target Repository

- Repository - https://github.com/arcadexyz/arcade-protocol
- Commit hash - <insert-final-hash-here>
- Language - Solidity
- Platform - Ethereum

## Changes in V3.1

- Prorated interest repayments
  - There is no minimum loan duration requirement on repayment allowing for Flash Loan style repayments.
- Partial borrower repayments
  - Borrowers can now repay a loan in multiple transactions.
  - Minimum repayment amount is the interest due on the loan at the time of repayment.
  - New functions to calculate effective interest rate for partial repayments.
- Optimistic settlement on loan origination
  - Flow of funds during origination goes entirely through the OriginationController contract for both starting a loan and rolling over an existing loan.
  - Callback function on borrower during loan origination.

## Vulnerability Level Details

Vulnerability threat level is determined on a 5-level scale:

| Level    | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | - Direct theft of any user funds, whether at-rest or in-motion, other than unclaimed yield <br> - Direct theft of any user NFTs, whether at-rest or in-motion, other than unclaimed royalties <br> - Permanent freezing of funds <br> - Permanent freezing of NFTs <br> - Ability for an attacker to cause the entire protocol to freeze, including loans in which they are not a counterparty <br> - Ability for an attacker to steal any asset held by the protocol, without limitation, including loans in which they are not a counterparty <br> - Unintended alteration of what the NFT represents (e.g. token URI, payload, artistic content) <br> - Ability for an attacker to claim collateral for defaulted loans in which they are not a counterparty                                                                                                                                                                                                                                                                                                                       |
| High     | - Theft of unclaimed yield <br> - Permanent freezing of unclaimed yield <br> - Temporary freezing of funds <br> - With the attacker as a borrower, the ability to regain control of collateral without repaying your loan <br> - With the attacker as a borrower, the ability to force your lender to issue loan funding without placing collateral in escrow <br> - With the attacker as a borrower, the ability to prevent a lender from claiming collateral when a loan is defaulted <br > - With the attacker as a lender, the ability to claim collateral before your loan’s due date <br> - With the attacker as a lender, the ability to prevent borrower repayments to force a default <br> - With the attacker as a lender, the ability to force a borrower to place collateral in escrow without issuing funding <br> - With the attacker as either counterparty, the ability to force another party to enter a loan under terms they did not consent to either via signature, or the other party submitting a function call <br> - Unauthorized minting of PromissoryNotes |
| Medium   | - Smart contract unable to operate due to lack of token funds <br> - Ability to freeze the protocol from originating new loans, without affecting currently open loans or locking assets <br> - Griefing (e.g. no profit motive for an attacker, but damage to the users or the protocol) <br> - Theft of gas <br> - Unbounded gas consumption <br> - Ability to drain protocol fees or block protocol fees <br> -Ability to block protocol fees from being withdrawn by contract owners <br> - Ability to bypass whitelisting requirements for loan collateral, payable currencies, and allowed verifiers <br> - Ability to manipulate whitelists for loan collateral, payable currencies, and allowed verifiers without the protocol-defined permissions (whitelist manager role)                                                                                                                                                                                                                                                                                                   |
| Low      | - Contract fails to deliver promised returns, but doesn't lose value <br> - Any finding which impacts protocol logic without circumventing loan rules or stealing/freezing user funds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| None     | - Gas optimizations <br> - Code style and formatting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Scope

<i>See scope.txt for a list of contracts in scope.</i>

| Contract Name               | SLOC | Purpose/ Description                                                                                                                                                                                                                                                                                                                                                                                                                                   | External Dependancies |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `LoanCore.sol`              | XXX  | The LoanCore contract is the core contract of the protocol. Both of the controller contracts call functions in this contract. This contract contains functions to start a loan, repay a loan, claim collateral of a loan that wasn’t repaid, rollover a loan, and withdrawal of fees. this contract is responsible for providing safe escrow of all collateral in an active loan as well as holding fees to be collected by the DAO or its affiliates. | `@openzeppelin/*`     |
| `OriginationController.sol` | XXX  | This contract is responsible for managing the origination of new loans. It is responsible for enforcing the protocol's origination rules, and for enforcing the protocol's whitelists. This contract contains functions to start a loan and to rollover a loan.                                                                                                                                                                                        | `@openzeppelin/*`     |
| `RepaymentController.sol`   | XXX  | This contract is responsible for managing the repayment of loans. It is responsible for enforcing the protocol's repayment rules. This contract contains functions to repay a loan and to claim collateral of a loan that was not repaid.                                                                                                                                                                                                              | `@openzeppelin/*`     |
| `LoanLibrary.sol`           | XXX  | This library contains all data types used across Arcade lending contracts.                                                                                                                                                                                                                                                                                                                                                                             | None                  |
| `InterestCalculator.sol`    | XXX  | This is an interface for calculating prorated interest amounts given the loan terms, current timestamp, and any previous repayments. This interface is used by the Arcade lending contracts to determine the prorated interest amount due at anytime in the loan's lifecycle.                                                                                                                                                                          | None                  |

## Out of Scope Details & Rules

Within the defined scope above, the general rules are that:

#### The lending protocol is based on the following assumptions about token behavior:

- External token contracts (for collateral and principal currency) are assumed to follow relevant token standards (ERC20, ERC721, ERC1155).
- Any attack related to token upgradeability is out of scope. Lost principal or fees related to fee-on-transfer tokens are out of scope.
- Attacks related to special admin permission of tokens (e.g. an ERC721 where admins can transfer any user’s tokens) are out of scope.
- Attacks related to explicitly malicious implementations of standard token functions (e.g. ERC20 tokens that consume the block gas limit on transfer) are out of scope.

#### The lending protocol assumes the following operational and trust models:

- For any contract which is Ownable or contains privileged operations for certain addresses (e.g. upgradeable contracts), the owner addresses are assumed to behave rationally and honestly.
- All contracts should be assumed to be deployed and configured correctly.
- Each counterparty in the loan process is assumed to act in their own financial self-interest.

Any finding or impact which is derived from one of the above assumptions being broken (e.g., an ERC721 that does not revert on a failed transfer, or an upgradeable ERC20 that can be made to fail on transfer via upgrade) is out of scope for this program.

Any finding based on one counterparty misleading the other as to the nature of the loan principal or collateral is out of scope. For instance, a borrower using a fake BAYC contract as collateral to trick a lender into giving favorable terms is an attack that is out of scope for this program.

Any attack related to convincing lenders to lend against assets flagged as stolen on other platforms (e.g. OpenSea) is out of scope.

Any phishing attack that requires social engineering in order to convince one counterparty to enter a loan under false pretenses (e.g. forcing them to sign loan terms differing from ones on a phishing UI), is considered out of scope for this program.

The following vulnerabilities are excluded from the audit scope:

- Attacks that the reporter has already exploited themselves, leading to damage
- Attacks requiring access to leaked keys/credentials
- Attacks requiring access to privileged addresses (governance, strategist)

#### Smart Contracts

- Basic economic governance attacks (e.g. 51% attack)
- Lack of liquidity
- Best practice critiques
- Sybil attacks
- Centralization risks
- Non-protocol related attacks around signatures (e.g. phishing sites that entice users to sign signatures with unfavorable terms)

### The following activities are prohibited during this audit:

- Any testing with mainnet or public testnet contracts; all testing should be done on private testnets
- Any testing with pricing oracles or third party smart contracts
- Attempting phishing or other social engineering attacks against our employees and/or customers
- Any testing with third party systems and applications (e.g. browser extensions) as well as websites (e.g. SSO providers, advertising networks)
- Any denial of service attacks
- Automated testing of services that generates significant amounts of traffic
- Public disclosure of an unpatched vulnerability in an embargoed bounty
