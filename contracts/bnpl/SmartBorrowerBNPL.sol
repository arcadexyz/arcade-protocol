// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../interfaces/IExpressBorrow.sol";
import "../interfaces/IOriginationController.sol";
import "../interfaces/IPromissoryNote.sol";

import "../external/interfaces/IWETH.sol";

import "../libraries/LoanLibrary.sol";

/**
 * @notice Smart contract that implements the ExpressBorrow interface and can be used to buy an
 *         NFT from a marketplace and use it as collateral for a loan.
 *
 *         This contract can only buy NFTs from a marketplace using ETH. The principal received
 *         from the loan must be in WETH. Then if applicable, the borrower sends the difference
 *         between the loan principal and the NFT list price to this contract. Then the WETH
 *         is converted to ETH to buy the NFT. If the loan principal is more than the NFT list
 *         price, the difference is sent back to the borrower.
 */
contract SmartBorrowerBNPL is IExpressBorrow, ERC721Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IWETH public constant WETH = IWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

    address public immutable originationController;
    address public immutable loanCore;
    address public immutable borrowerNote;

    address public borrower;

    struct MarketplaceData {
        address marketplace;
        uint256 listPrice;
        bytes marketplaceData; // encoded 'buy' function call
    }

    mapping(address => bool) public approvedMarketplaces;

    event BNPLExecuted(
        address indexed borrower,
        address indexed marketplace,
        address indexed collateralAddress,
        uint256 collateralId
    );

    constructor(address _originationController, address _loanCore, address _borrowerNote) {
        require(_originationController != address(0), "Origination controller cannot be address(0)");
        require(_loanCore != address(0), "LoanCore cannot be address(0)");
        require(_borrowerNote != address(0), "BorrowerNote cannot be address(0)");

        originationController = _originationController;
        loanCore = _loanCore;
        borrowerNote = _borrowerNote;
    }

    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        bytes calldata marketplaceData,
        address lender,
        IOriginationController.Signature calldata sig,
        IOriginationController.SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public {
        // cache borrower address
        borrower = msg.sender;

        // create borrower data where this contract stands in as borrower
        IOriginationController.BorrowerData memory borrowerData = IOriginationController.BorrowerData({
            borrower: address(this),
            callbackData: marketplaceData
        });

        uint256 newLoanId = IOriginationController(originationController).initializeLoan(
            loanTerms,
            borrowerData,
            lender,
            sig,
            sigProperties,
            itemPredicates
        );

        // transfer BorrowerNote to the caller
        IPromissoryNote(borrowerNote).safeTransferFrom(address(this), borrower, newLoanId);
    }

    /**
     * @notice Callback for loan origination. This function is called by the OriginationController
     *         when a loan is being initiated. This contract receives the funds from the loan and
     *         uses the funds to buy the NFT from an approved marketplace.
     */
    function executeOperation(
        address loanOriginationCaller, // loanOriginationCaller
        address, // lender
        LoanLibrary.LoanTerms calldata loanTerms,
        uint256 borrowerFee,
        bytes calldata callbackData
    ) external override {
        require(loanOriginationCaller == address(this), "Initiator must be this contract");
        require(msg.sender == originationController, "Caller must be OriginationController");

        // decode marketplace data
        MarketplaceData memory data = abi.decode(callbackData, (MarketplaceData));
        // verify the marketplace is registered as a valid marketplace
        require(approvedMarketplaces[data.marketplace], "Marketplace not approved");

        // loanTerms.payableCurrency must be WETH so we can use it to buy the NFT in ETH
        require(loanTerms.payableCurrency == address(WETH), "Payable currency must be WETH");
        (
            uint256 amountBorrowerOwes,
            uint256 borrowerRefund
        ) = _ensureFunds(data.listPrice, loanTerms.principal, borrowerFee);

        if (amountBorrowerOwes > 0) {
            // collect funds from borrower
            IERC20(address(WETH)).safeTransferFrom(borrower, address(this), amountBorrowerOwes);
        }
        if (borrowerRefund > 0) {
            // send refund to borrower
            IERC20(address(WETH)).safeTransfer(borrower, borrowerRefund);
        }

        require(
            IERC20(address(WETH)).balanceOf(address(this)) >= data.listPrice,
            "Not enough funds to buy NFT"
        );

        // unwrap WETH to ETH
        WETH.withdraw(data.listPrice);

        require(address(this).balance >= data.listPrice, "Not enough ETH to buy NFT");

        // execute marketplace buy
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = data.marketplace.call{value: data.listPrice}(data.marketplaceData);
        require(success, "Marketplace buy failed");

        require (
            IERC721(loanTerms.collateralAddress).ownerOf(loanTerms.collateralId) == address(this),
            "NFT not transferred"
        );

        // this contract now holds the NFT. Approve the LoanCore to take it when starting loan
        IERC721(loanTerms.collateralAddress).approve(originationController, loanTerms.collateralId);

        emit BNPLExecuted(borrower, data.marketplace, loanTerms.collateralAddress, loanTerms.collateralId);
    }

    function _ensureFunds(
        uint256 listPrice,
        uint256 principal,
        uint256 borrowerFee
    ) internal pure returns (uint256 amountBorrowerOwes, uint256 borrowerRefund) {
        uint256 receivedFromLoan = principal - borrowerFee;

        if (receivedFromLoan > listPrice) {
            // loan is more than list price, send difference back to borrower
            borrowerRefund = receivedFromLoan - listPrice;
        } else if (receivedFromLoan < listPrice) {
            // loan is less than list price, borrower needs to pay difference
            amountBorrowerOwes = listPrice - receivedFromLoan;
        } else {
            // loan is equal to list price, no action needed
            return (0, 0);
        }
    }

    function setApprovedMarketplace(address marketplace, bool approved) external {
        approvedMarketplaces[marketplace] = approved;
    }

    receive() external payable {}
}