// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract ERC1271LenderMock is IERC1271, IERC721Receiver {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    address public signer;

    constructor(address _signer) {
        signer = _signer;
    }

    function approve(address token, address target) external {
        IERC20(token).approve(target, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes memory signature) public view override returns (bytes4 magicValue) {
        (address recovered, ) = ECDSA.tryRecover(hash, signature);

        if (recovered == signer) return MAGICVALUE;
        else return 0xFFFFFFFF;
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
