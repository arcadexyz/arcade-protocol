// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../origination/OriginationController.sol";

contract MockNoValidationOC is OriginationController {
    constructor(
        address _originationConfiguration,
        address _loanCore,
        address _feeController
    ) OriginationController(_originationConfiguration, _loanCore, _feeController) {}

    function _validateLoanTerms(LoanLibrary.LoanTerms memory terms) internal view override {
        // no-op - no validation
    }
}