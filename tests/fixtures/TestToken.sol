// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only token with just the reads the token gate uses:
/// ERC-721 (+ Enumerable) and ERC-1155 balanceOf. Not a real token.
contract TestToken {
    mapping(uint256 => address) private owners;
    mapping(address => uint256[]) private owned;
    mapping(uint256 => uint256) private ownedIndex;
    mapping(address => mapping(uint256 => uint256)) private balances1155;
    bool public enumerable = true;

    function ownerOf(uint256 id) external view returns (address holder) {
        holder = owners[id];
        require(holder != address(0), "nonexistent token");
    }

    function balanceOf(address account) external view returns (uint256) {
        return owned[account].length;
    }

    function tokenOfOwnerByIndex(address account, uint256 index) external view returns (uint256) {
        require(enumerable, "not enumerable");
        require(index < owned[account].length, "index out of range");
        return owned[account][index];
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return balances1155[account][id];
    }

    function mint(address to, uint256 id) external {
        require(owners[id] == address(0), "exists");
        add(to, id);
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(owners[id] == from, "not owner");
        remove(from, id);
        add(to, id);
    }

    function mint1155(address to, uint256 id, uint256 amount) external {
        balances1155[to][id] += amount;
    }

    function setEnumerable(bool on) external {
        enumerable = on;
    }

    function add(address to, uint256 id) private {
        owners[id] = to;
        ownedIndex[id] = owned[to].length;
        owned[to].push(id);
    }

    function remove(address from, uint256 id) private {
        uint256 last = owned[from][owned[from].length - 1];
        uint256 index = ownedIndex[id];
        owned[from][index] = last;
        ownedIndex[last] = index;
        owned[from].pop();
        delete owners[id];
    }
}
