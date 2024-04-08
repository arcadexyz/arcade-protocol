// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/OriginationLibrary.sol";
import "../libraries/LoanLibrary.sol";

interface IOriginationHelpers {
    // ================ Events ===================

    event SetAllowedVerifier(address indexed verifier, bool isAllowed);
    event SetAllowedCurrency(address indexed currency, bool isAllowed, uint256 minPrincipal);
    event SetAllowedCollateral(address indexed collateral, bool isAllowed);

    // ============= View Functions ==============

    function validateLoanTerms(LoanLibrary.LoanTerms memory terms) external view;

    function validateWhitelist(address currency, uint256 principalAmount, address collateral) external view;

    function runPredicatesCheck(
        address borrower,
        address lender,
        LoanLibrary.LoanTerms memory loanTerms,
        LoanLibrary.Predicate[] memory itemPredicates
    ) external view;

    function isAllowedVerifier(address verifier) external view returns (bool);

    function isAllowedCurrency(address currency) external view returns (bool);

    function getMinPrincipal(address currency) external view returns (uint256);

    function isAllowedCollateral(address collateral) external view returns (bool);

    // ================== Admin ==================

    function setAllowedVerifiers(address[] calldata verifiers, bool[] calldata isAllowed) external;

    function setAllowedPayableCurrencies(
        address[] calldata tokens,
        OriginationLibrary.Currency[] calldata currencyData
    ) external;

    function setAllowedCollateralAddresses(
        address[] calldata tokens,
        bool[] calldata isAllowed
    ) external;
}
