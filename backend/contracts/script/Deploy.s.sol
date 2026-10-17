// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AlphaClock} from "../src/AlphaClock.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * 部署 AlphaClock。
 *
 *   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
 *
 * 环境变量：
 *   PRIVATE_KEY        部署者私钥
 *   VERIFIER_ADDRESS   x402 结算写回者（默认 = 部署者）
 *   TREASURY_ADDRESS   平台金库（默认 = 部署者）
 *   USDC_ADDRESS       已存在的 USDC（不填则本地部署 MockUSDC）
 *
 * 写入 ./deployments.json 供前端/服务器读取。
 */
contract Deploy is Script {
    // Monad 测试网 USDC（Circle 官方）
    address constant MONAD_TESTNET_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address verifier = vm.envOr("VERIFIER_ADDRESS", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));

        vm.startBroadcast(pk);

        IERC20 usdc;
        bool isMock;
        if (usdcAddr == address(0)) {
            if (block.chainid == 10143) {
                usdcAddr = MONAD_TESTNET_USDC;
            }
        }

        if (usdcAddr == address(0)) {
            MockUSDC mock = new MockUSDC();
            usdcAddr = address(mock);
            isMock = true;
            console.log("MockUSDC deployed:", usdcAddr);
        }
        usdc = IERC20(usdcAddr);

        AlphaClock clock = new AlphaClock(usdc, treasury, verifier);

        vm.stopBroadcast();

        console.log("chainId      :", block.chainid);
        console.log("USDC         :", usdcAddr);
        console.log("isMockUSDC   :", isMock);
        console.log("AlphaClock   :", address(clock));
        console.log("verifier     :", verifier);
        console.log("treasury     :", treasury);

        string memory json = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "usdc": "',
            vm.toString(usdcAddr),
            '",\n  "isMockUSDC": ',
            isMock ? "true" : "false",
            ',\n  "alphaClock": "',
            vm.toString(address(clock)),
            '",\n  "verifier": "',
            vm.toString(verifier),
            '",\n  "treasury": "',
            vm.toString(treasury),
            '"\n}\n'
        );
        vm.writeFile("./deployments.json", json);
        console.log("wrote ./deployments.json");
    }
}
