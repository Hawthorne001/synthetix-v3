//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// solhint-disable-next-line no-empty-blocks
contract ImplementationDestroyer {
    function safeUpgradeTo(address) public {
        selfdestruct(payable(0));
    }
}
