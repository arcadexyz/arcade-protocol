// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";

import "./libraries/OriginationLibrary.sol";

import "./interfaces/IOriginationSharedStorage.sol";

import {
    OC_ZeroAddress,
    OSS_NotWhitelisted,
    OSS_BatchLengthMismatch,
    OSS_ZeroArrayElements,
    OSS_ArrayTooManyElements
} from "./errors/Lending.sol";

contract OriginationSharedStorage is IOriginationSharedStorage, AccessControlEnumerable {
    // ====================================== CONSTANTS ===========================================

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN");
    bytes32 public constant WHITELIST_MANAGER_ROLE = keccak256("WHITELIST_MANAGER");

    // ==================================== SHARED STORAGE ========================================

    /// @notice Mapping from address to whether that verifier contract has been whitelisted
    mapping(address => bool) private _allowedVerifiers;
    /// @notice Mapping from ERC20 token address to boolean indicating allowed payable currencies and set minimums
    mapping(address => OriginationLibrary.Currency) private _allowedCurrencies;
    /// @notice Mapping from ERC721 or ERC1155 token address to boolean indicating allowed collateral types
    mapping(address => bool) private _allowedCollateral;

    // ======================================= CONSTRUCTOR ========================================

    constructor() {
        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);

        _setupRole(WHITELIST_MANAGER_ROLE, msg.sender);
        _setRoleAdmin(WHITELIST_MANAGER_ROLE, ADMIN_ROLE);
    }

    // ========================================= VIEW ===========================================

    /**
     * @notice Returns whether the specified verifier contract is whitelisted.
     *
     * @param verifier              The address of the specified verifier contract.
     *
     * @return bool                 Whether the specified verifier contract is whitelisted or not.
     */
    function isAllowedVerifier(address verifier) public view returns (bool) {
        return _allowedVerifiers[verifier];
    }

    /**
     * @notice Returns whether the specified currency is whitelisted.
     *
     * @param currency              The address of the specified currency.
     *
     * @return bool                 Whether the specified currency is whitelisted or not.
     */
    function isAllowedCurrency(address currency) public view returns (bool) {
        return _allowedCurrencies[currency].isAllowed;
    }

    /**
     * @notice Returns the minimum principal amount for the specified currency.
     *
     * @param currency              The address of the specified currency.
     *
     * @return minPrincipal         The minimum principal amount for the specified currency.
     */
    function getMinPrincipal(address currency) public view returns (uint256) {
        if (!_allowedCurrencies[currency].isAllowed) revert OSS_NotWhitelisted(currency);

        return _allowedCurrencies[currency].minPrincipal;
    }

    /**
     * @notice Returns whether the specified collateral is whitelisted.
     *
     * @param collateral            The address of the specified collateral.
     *
     * @return bool                 Whether the specified collateral is whitelisted or not.
     */
    function isAllowedCollateral(address collateral) public view returns (bool) {
        return _allowedCollateral[collateral];
    }

    // ========================================= ADMIN ==========================================

    /**
     * @notice Batch update for verification whitelist.
     *
     * @param verifiers             The list of specified verifier contracts, should implement ISignatureVerifier.
     * @param isAllowed             Whether the specified contracts should be allowed, respectively.
     */
    function setAllowedVerifiers(
        address[] calldata verifiers,
        bool[] calldata isAllowed
    ) external override onlyRole(WHITELIST_MANAGER_ROLE) {
        if (verifiers.length == 0) revert OSS_ZeroArrayElements();
        if (verifiers.length > 50) revert OSS_ArrayTooManyElements();
        if (verifiers.length != isAllowed.length) revert OSS_BatchLengthMismatch();

        for (uint256 i = 0; i < verifiers.length;) {
            if (verifiers[i] == address(0)) revert OC_ZeroAddress("verifier");

            _allowedVerifiers[verifiers[i]] = isAllowed[i];
            emit SetAllowedVerifier(verifiers[i], isAllowed[i]);

            // Can never overflow because length is bounded by 50
            unchecked {
                i++;
            }
        }
    }

    /**
     * @notice Adds an array of payable currencies to the allowed currencies mapping.
     *
     * @dev Entire transaction reverts if one of the addresses is the zero address.
     *      The array of addresses passed to this function is limited to 50 elements.
     *
     * @param tokens                     Array of token addresses to add.
     * @param currencyData               Whether the token is allowed or not, and the minimum loan size.
     */
    function setAllowedPayableCurrencies(
        address[] calldata tokens,
        OriginationLibrary.Currency[] calldata currencyData
    ) external override onlyRole(WHITELIST_MANAGER_ROLE) {
        if (tokens.length == 0) revert OSS_ZeroArrayElements();
        if (tokens.length > 50) revert OSS_ArrayTooManyElements();
        if (tokens.length != currencyData.length) revert OSS_BatchLengthMismatch();

        for (uint256 i = 0; i < tokens.length;) {
            if (tokens[i] == address(0)) revert OC_ZeroAddress("token");

            _allowedCurrencies[tokens[i]] = currencyData[i];
            emit SetAllowedCurrency(tokens[i], currencyData[i].isAllowed, currencyData[i].minPrincipal);

            // Can never overflow because length is bounded by 50
            unchecked {
                i++;
            }
        }
    }

    /**
     * @notice Adds an array collateral tokens to the allowed collateral mapping.
     *
     * @dev Entire transaction reverts if one of the addresses is the zero address.
     *       The array of addresses passed to this function is limited to 50 elements.
     *
     * @param tokens                     Array of token addresses to add.
     * @param isAllowed                  Whether the token is allowed or not.
     */
    function setAllowedCollateralAddresses(
        address[] calldata tokens,
        bool[] calldata isAllowed
    ) external override onlyRole(WHITELIST_MANAGER_ROLE) {
        if (tokens.length == 0) revert OSS_ZeroArrayElements();
        if (tokens.length > 50) revert OSS_ArrayTooManyElements();
        if (tokens.length != isAllowed.length) revert OSS_BatchLengthMismatch();

        for (uint256 i = 0; i < tokens.length;) {
            if (tokens[i] == address(0)) revert OC_ZeroAddress("token");

            _allowedCollateral[tokens[i]] = isAllowed[i];
            emit SetAllowedCollateral(tokens[i], isAllowed[i]);

            // Can never overflow because length is bounded by 50
            unchecked {
                i++;
            }
        }
    }
}