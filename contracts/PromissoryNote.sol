// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Pausable.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "base64-sol/base64.sol";

import "./ERC721Permit.sol";
import "./interfaces/ILoanCore.sol";
import "./interfaces/IPromissoryNote.sol";

import { PN_MintingRole, PN_BurningRole, PN_ContractPaused, PN_CannotInitialize, PN_AlreadyInitialized } from "./errors/Lending.sol";

/**
 * @title PromissoryNote
 * @author Non-Fungible Technologies, Inc.
 *
 * Built off Openzeppelin's ERC721PresetMinterPauserAutoId. Used for
 * representing rights and obligations in the context of a loan - the
 * right to claim collateral for lenders (instantiated as LenderNote),
 * and the right to recover collateral upon repayment for borrowers
 * (instantiated as BorrowerNote).
 *
 * @dev {ERC721} token, including:
 *
 *  - ability for holders to burn (destroy) their tokens
 *  - a minter role that allows for token minting (creation)
 *  - token ID and URI autogeneration
 *
 * This contract uses {AccessControl} to lock permissioned functions using the
 * different roles - head to its documentation for details.
 *
 * The account that deploys the contract will be granted the minter and pauser
 * roles, as well as the admin role, which will let it grant both minter
 * and pauser roles to other accounts.
 */
contract PromissoryNote is
    Context,
    AccessControlEnumerable,
    ERC721Enumerable,
    ERC721Pausable,
    ERC721Permit,
    IPromissoryNote
{
    using Counters for Counters.Counter;
    using Strings for uint256;

    // ============================================ STATE ==============================================

    // =================== Constants =====================

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // =================== Loan State =====================
    string public baseURI;

    /// @dev Initially deployer, then account with burn/mint/pause roles (LoanCore).
    address public owner;
    bool private initialized;

    Counters.Counter private _tokenIdTracker;

    // ========================================= CONSTRUCTOR ===========================================

    /**
     * @dev Creates the promissory note contract, granting minter, burner
     *      and pauser roles to the specified owner address (which in practice
     *      will be LoanCore).
     *
     * @param name                  The name of the token (see ERC721).
     * @param symbol                The symbol of the token (see ERC721).
     * @param _baseURI              The value of the baseURI state variable.
     */
    constructor(
        string memory name,
        string memory symbol,
        string memory _baseURI
    ) ERC721(name, symbol) ERC721Permit(name) {
        // We don't want token IDs of 0
        _tokenIdTracker.increment();

        baseURI = _baseURI;

        owner = msg.sender;
    }

    /**
     * @notice Grants owner access to the specified address, which should be an
     *         instance of LoanCore. Once admin role is set, it is immutable,
     *         and cannot be set again.
     *
     * @param loanCore              The address of the admin.
     */
    function initialize(address loanCore) external {
        if (initialized) revert PN_AlreadyInitialized();
        if (msg.sender != owner) revert PN_CannotInitialize();

        _setupRole(ADMIN_ROLE, loanCore);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);

        owner = loanCore;
        initialized = true;
    }

    // ======================================= TOKEN OPERATIONS =========================================

    /**
     * @notice Create a new token and assign it to a specified owner. The token ID
     *         should match the loan ID, and can only be called by the minter. Also
     *         updates the mapping to lookup loan IDs by note IDs.
     *
     * @dev See {ERC721-_mint}.
     *
     * @param to                    The owner of the minted token.
     * @param loanId                The ID of the token to mint, should match a loan.
     *
     * @return tokenId              The newly minted token ID.
     */
    function mint(address to, uint256 loanId) external override returns (uint256) {
        if (!hasRole(ADMIN_ROLE, msg.sender)) revert PN_MintingRole(msg.sender);
        _mint(to, loanId);

        return loanId;
    }

    /**
     * @notice Getter of specific URI for an ERC721 token ID.
     *
     * @param tokenId               The ID of the token to get the URI for.
     *
     * @return                      The token ID's URI.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _exists(tokenId);

        return bytes(baseURI).length > 0 ? string(abi.encodePacked(baseURI, tokenId.toString())) : "";
    }

    /**
     * @notice An ADMIN_ROLE function for setting the string value of the base URI.
     *
     * @param newBaseURI              The new value of the base URI.
     *
     */
    function setBaseURI(string memory newBaseURI) public onlyRole(ADMIN_ROLE) {
        baseURI = newBaseURI;
    }

    /**
     * @notice Burn a token assigned to a specified owner. The token ID should match a loan ID,
     *         and can only be called by a burner - in practice LoanCore, which burns notes when
     *         a loan ends.
     *
     * @dev See {ERC721-_burn}.
     *
     * @param tokenId               The ID of the token to burn, should match a loan.
     */
    function burn(uint256 tokenId) external override {
        if (!hasRole(ADMIN_ROLE, msg.sender)) revert PN_BurningRole(msg.sender);
        _burn(tokenId);
    }

    /**
     * @notice Pauses transfers on the note. This essentially blocks all loan lifecycle
     *         operations, since all originations and transfers require transfers of
     *         the note.
     *
     * @param paused                Whether the contract should be paused.
     */
    function setPaused(bool paused) external override onlyRole(ADMIN_ROLE) {
        if (paused) {
            _pause();
        } else {
            _unpause();
        }
    }

    // ===================================== ERC721 UTILITIES ============================================

    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlEnumerable, ERC721, ERC721Enumerable, IERC165)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @dev Hook that is called before any token transfer.
     *      This notifies the promissory note about the ownership transfer.
     *
     * @dev Does not let tokens be transferred when contract is paused.
     *
     * @param from                  The previous owner of the token.
     * @param to                    The owner of the token after transfer.
     * @param tokenId               The token ID.
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId
    ) internal virtual override(ERC721, ERC721Enumerable, ERC721Pausable) {
        if (paused()) revert PN_ContractPaused();

        super._beforeTokenTransfer(from, to, tokenId);
    }
}
