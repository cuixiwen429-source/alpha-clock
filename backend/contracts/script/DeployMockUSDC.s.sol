// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * 单独部署 MockUSDC，当作测试网演示用的门票币
 * （Monad 测试网官方 USDC 几乎没人用，水龙头也发不到，见 docs/领币操作卡.md）。
 *
 *   forge script script/DeployMockUSDC.s.sol --rpc-url $RPC_URL --broadcast
 *
 * 拿到地址后，把它填进 backend/.env 的 USDC_ADDRESS，再跑 Deploy.s.sol，
 * 这样 AlphaClock 收的就是这个可以自己 mint 发给观众的 USDC，不依赖外部水龙头。
 * 不改动 Deploy.s.sol 本身的逻辑（它在 USDC_ADDRESS 为空时会在 Monad 测试网上
 * 默认用官方 USDC 地址，这是刻意的默认行为，不是 bug）。
 */
contract DeployMockUSDC is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        MockUSDC mock = new MockUSDC();
        vm.stopBroadcast();
        console.log("MockUSDC deployed:", address(mock));
    }
}
