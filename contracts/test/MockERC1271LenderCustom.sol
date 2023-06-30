// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC1271LenderCustom is IERC1271, IERC721Receiver {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    address public signer;

    bytes public expectedData = hex"0000_1234";

    constructor(address _signer) {
        signer = _signer;
    }

    function approve(address token, address target) external {
        IERC20(token).approve(target, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes memory signature)public view override returns (bytes4) {
        uint8 v;
        bytes32 r;
        bytes32 s;

        // Check the signature length
        // - case >65: signature with extra data
        if (signature.length > 65) {
            // recover the signer
            // solhint-disable-next-line no-inline-assembly
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            (address recovered, ) = ECDSA.tryRecover(hash, v, r, s);

            // get extra data
            bytes memory extraData;

            // recover the extra data
            // solhint-disable-next-line no-inline-assembly
            assembly {
                let sigLength := mload(signature)
                let extraDataLength := sub(sigLength, 65)
                extraData := add(signature, 65) // point to memory offset of extra data
                mstore(extraData, extraDataLength) // store extra data
            }
            
            // check if the extra data is the expected data and the signer is the expected signer
            if(keccak256(extraData) == keccak256(expectedData) && recovered == signer) return MAGICVALUE;
            else return 0xFFFFFFFF;
        }
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
