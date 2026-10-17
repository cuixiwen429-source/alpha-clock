// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MockUSDC
 * @notice 本地 / 测试用的 USDC 替身，实现了 x402 依赖的 EIP-3009 transferWithAuthorization。
 *
 * 为什么要它：Monad 测试网上已有真 USDC（0x534b2f3A21130d7a60830c2Df862319e593943A3），
 * 但黑客松现场 Wi-Fi 极可能崩。有了这个 Mock，整套「Agent 付费 → facilitator 结算 → 上链」
 * 流程可以在本机 anvil 上完整跑通，完全不依赖外网。
 *
 * EIP-712 domain 与真 USDC 保持一致：name="USDC", version="2"。
 */
contract MockUSDC is ERC20, EIP712 {
    struct TransferWithAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev nonce => 是否已被使用
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USD Coin", "USDC") EIP712("USDC", "2") {
        _mint(msg.sender, 1_000_000 * 10 ** 6); // 1,000,000 USDC 给部署者
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev x402 的 ExactEvmScheme 会读这两个方法；真 USDC 的 EIP-712 domain 就是 name="USDC", version="2"
    function version() external pure returns (string memory) {
        return "2";
    }

    /// @notice 任何人可领的测试水龙头（本地 demo 用）
    function faucet(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice EIP-3009：由付款方离线签名，第三方（facilitator）代为提交。
     * @dev 这是 `bytes signature` 版本。x402 的 SDK 在签名为 65 字节 ECDSA 时会改用下面的
     *      9 参数版本（v/r/s 分开），两个都必须实现 —— 真 USDC（FiatTokenV2）也是这么做的。
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    /// @notice 9 参数版本（x402 SDK 默认走这条）
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        require(block.timestamp > validAfter, "MockUSDC: not yet valid");
        require(block.timestamp < validBefore, "MockUSDC: expired");
        require(!authorizationState[from][nonce], "MockUSDC: authorization used");

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        require(err == ECDSA.RecoverError.NoError && recovered == from, "MockUSDC: bad signature");

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice 供客户端构造 EIP-712 签名时读取
    function transferWithAuthorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return _hashTypedDataV4(structHash);
    }
}
