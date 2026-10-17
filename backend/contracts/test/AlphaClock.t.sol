// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {AlphaClock} from "../src/AlphaClock.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract AlphaClockTest is Test {
    AlphaClock clock;
    MockUSDC usdc;

    address publisher = address(0xA11CE);
    address buyer1 = address(0xB0B);
    address buyer2 = address(0xCAFE);
    address treasury = address(0x7BEA5);

    uint128 constant BASE = 10_000_000; // $10
    uint128 constant FLOOR = 10_000; // $0.01
    uint32 constant HALF_LIFE = 120; // 2 分钟

    function setUp() public {
        usdc = new MockUSDC();
        clock = new AlphaClock(usdc, treasury, address(this));

        usdc.faucet(publisher, 1_000_000_000);
        usdc.faucet(buyer1, 1_000_000_000);
        usdc.faucet(buyer2, 1_000_000_000);

        vm.prank(publisher);
        usdc.approve(address(clock), type(uint256).max);
        vm.prank(buyer1);
        usdc.approve(address(clock), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(clock), type(uint256).max);
    }

    function _publish() internal returns (uint256 id) {
        vm.prank(publisher);
        id = clock.publish(unicode"某公司将被收购", "ipfs://preview", "ipfs://content", BASE, FLOOR, HALF_LIFE);
    }

    // ---------------------------------------------------------------- 定价

    function test_PriceStartsAtBase() public {
        uint256 id = _publish();
        assertEq(clock.currentPrice(id), BASE);
        assertEq(clock.halvingsElapsed(id), 0);
    }

    function test_HalvesEveryHalfLife() public {
        uint256 id = _publish();
        uint64 t0 = uint64(block.timestamp);

        vm.warp(t0 + HALF_LIFE);
        assertEq(clock.currentPrice(id), BASE / 2, "1 half-life -> 50%");

        vm.warp(t0 + HALF_LIFE * 2);
        assertEq(clock.currentPrice(id), BASE / 4, "2 half-lives -> 25%");

        vm.warp(t0 + HALF_LIFE * 3);
        assertEq(clock.currentPrice(id), BASE / 8, "3 half-lives -> 12.5%");
    }

    /**
     * floorPrice 只有在"自然衰减会掉到它下面"时才有意义。
     * $10 起始 + 8 个半衰期免费 ⇒ 自然最低点是 $10/128 = $0.078，
     * 所以地板必须设在 $0.078 以上才拦得住。这里用 $0.5。
     */
    function test_FloorHoldsPrice() public {
        vm.prank(publisher);
        uint256 id = clock.publish(unicode"测试消息", "", "", BASE, 500_000, HALF_LIFE);
        uint64 t0 = uint64(block.timestamp);

        vm.warp(t0 + HALF_LIFE * 4); // 自然价 $0.625，仍高于地板
        assertEq(clock.currentPrice(id), 625_000);

        vm.warp(t0 + HALF_LIFE * 5); // 自然价 $0.3125，被地板拦住
        assertEq(clock.currentPrice(id), 500_000, "clamped to floor");

        vm.warp(t0 + HALF_LIFE * 7); // 仍在地板
        assertEq(clock.currentPrice(id), 500_000, "still floor");

        vm.warp(t0 + HALF_LIFE * 8); // 到期免费，地板让位
        assertEq(clock.currentPrice(id), 0, "free overrides floor");
    }

    function test_BecomesFreeAfterOpenHalvings() public {
        uint256 id = _publish();
        uint64 t0 = uint64(block.timestamp);

        vm.warp(t0 + HALF_LIFE * 8);
        assertEq(clock.currentPrice(id), 0);
        assertTrue(clock.isFree(id));
    }

    function test_TimeToFreeCountsDown() public {
        uint256 id = _publish();
        uint64 t0 = uint64(block.timestamp);
        assertEq(clock.timeToFree(id), HALF_LIFE * 8);

        vm.warp(t0 + 60);
        assertEq(clock.timeToFree(id), HALF_LIFE * 8 - 60);
    }

    // ---------------------------------------------------------------- 购买

    function test_BuySplitsRevenue() public {
        uint256 id = _publish();
        uint128 p = clock.currentPrice(id);

        uint128 pubBefore = uint128(usdc.balanceOf(publisher));
        uint128 tBefore = uint128(usdc.balanceOf(treasury));

        vm.prank(buyer1);
        uint128 paid = clock.buy(id);

        assertEq(paid, p);
        assertTrue(clock.hasAccess(id, buyer1));
        assertEq(clock.paidPrice(id, buyer1), p);

        uint128 fee = uint128((uint256(p) * 500) / 10_000);
        assertEq(usdc.balanceOf(publisher), pubBefore + (p - fee), "publisher gets 95%");
        assertEq(usdc.balanceOf(treasury), tBefore + fee, "treasury gets 5%");
        assertEq(usdc.balanceOf(address(clock)), 0, "contract custodies nothing");
    }

    function test_CannotBuyTwice() public {
        uint256 id = _publish();
        vm.prank(buyer1);
        clock.buy(id);

        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.PriceMoved.selector);
        clock.buy(id);
    }

    function test_LaterBuyerPaysLess() public {
        uint256 id = _publish();
        uint64 t0 = uint64(block.timestamp);

        vm.prank(buyer1);
        uint128 first = clock.buy(id);

        vm.warp(t0 + HALF_LIFE);
        vm.prank(buyer2);
        uint128 second = clock.buy(id);

        assertEq(first, BASE);
        assertEq(second, BASE / 2);
        assertEq(clock.accessCount(id), 2);
    }

    function test_CannotBuyAfterFree() public {
        uint256 id = _publish();
        vm.warp(uint64(block.timestamp) + HALF_LIFE * 8);
        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.FreeAlready.selector);
        clock.buy(id);
    }

    // ---------------------------------------------------------------- x402

    function test_RecordX402OnlyByVerifier() public {
        uint256 id = _publish();
        // 本测试合约就是 verifier
        clock.recordX402(id, buyer1, 5_000_000);
        assertTrue(clock.hasAccess(id, buyer1));
        assertEq(clock.accessCount(id), 1);

        vm.prank(buyer2);
        vm.expectRevert(AlphaClock.NotVerifier.selector);
        clock.recordX402(id, buyer2, 5_000_000);
    }

    function test_X402CountsRevenue() public {
        uint256 id = _publish();
        clock.recordX402(id, buyer1, 4_000_000);
        clock.recordX402(id, buyer2, 2_000_000);

        uint128 revenue = clock.getSignal(id).revenue;
        assertEq(revenue, 6_000_000);
    }

    // ---------------------------------------------------------------- 曲线

    function test_CurveIsMonotonicDecreasing() public {
        uint256 id = _publish();
        (uint128[] memory prices,) = clock.curve(id, 16);

        assertEq(prices[0], BASE);
        for (uint256 i = 1; i < prices.length; i++) {
            assertLe(prices[i], prices[i - 1], "curve must never go up");
        }
    }

    function test_RevertWhenBadParams() public {
        vm.prank(publisher);
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.publish("x", "", "", 0, 0, 60);

        vm.prank(publisher);
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.publish("x", "", "", 100, 0, 0);
    }

    // ---------------------------------------------------------------- 场景

    /**
     * 复刻真实场景：一条消息在 2 分钟内被 8 个人以 8 个不同价格买走。
     * 打印每一笔的价格，用来验证"价格阶梯"是否和预期一致。
     */
    function test_EightBuyersInTwoMinutes() public {
        uint256 id = _publish();
        uint64 t0 = uint64(block.timestamp);

        console.log("elapsed(s)  price(USDC)  total");
        uint128 total;
        for (uint32 i = 0; i < 8; i++) {
            vm.warp(t0 + uint64(i) * 15);
            address b = address(uint160(0x1000 + i));
            usdc.faucet(b, 1_000_000_000);
            vm.prank(b);
            usdc.approve(address(clock), type(uint256).max);
            vm.prank(b);
            uint128 p = clock.buy(id);
            total += p;
            console.log(i * 15, p);
            console.log("            total:", total);
        }
        uint128 revenue = clock.getSignal(id).revenue;
        assertEq(revenue, total);
        assertEq(clock.accessCount(id), 8);
    }
}
