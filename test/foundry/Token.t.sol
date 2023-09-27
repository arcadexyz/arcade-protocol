// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "forge-std/Test.sol";

import "../../contracts/test/MockERC20.sol";

contract TokenTest is Test {
    MockERC20 public t;

    function setUp() public {
        t = new MockERC20("MockERC20", "MERC20");
    }

    function testName() public {
        assertEq(t.name(), "MockERC20");
    }
}