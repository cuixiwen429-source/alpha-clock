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
    bytes32 constant HASH = keccak256(unicode"某公司将被收购：正文");

    function setUp() public {
        usdc = new MockUSDC();
        // 本测试合约 = verifier
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
        id = clock.publish(unicode"某公司将被收购", "ipfs://preview", HASH, BASE, FLOOR, HALF_LIFE);
    }

    // ---------------------------------------------------------------- 发布

    function test_PublishStoresCommitment() public {
        uint256 id = _publish();
        AlphaClock.SignalView memory v = clock.getSignal(id);

        assertEq(id, 1);
        assertEq(clock.signalCount(), 1);
        assertEq(v.publisher, publisher);
        assertEq(v.contentHash, HASH, unicode"正文哈希上链");
        assertEq(v.basePrice, BASE);
        assertEq(v.floorPrice, FLOOR);
        assertEq(v.halfLife, HALF_LIFE);
        assertEq(v.publishedAt, uint64(block.timestamp));
        assertFalse(v.forcedOpen);
        assertEq(v.price, BASE);
        assertFalse(v.freeNow);
    }

    function test_PublishEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(clock));
        emit AlphaClock.Published(1, publisher, unicode"某公司将被收购", BASE, FLOOR, HALF_LIFE, HASH, uint64(block.timestamp));
        _publish();
    }

    function test_RevertWhenBadParams() public {
        // basePrice = 0
        vm.startPrank(publisher);
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.publish("x", "", HASH, 0, 0, 60);

        // halfLife = 0
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.publish("x", "", HASH, 100, 0, 0);

        // floor > base
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.publish("x", "", HASH, 100, 200, 60);

        // 空标题
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.publish("", "", HASH, 100, 0, 60);
        vm.stopPrank();
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
     * 与 shared/curve.mjs 的定点值逐位一致。前端算出来的价和后端、合约
     * 必须是同一个数，否则"再等 3 秒省 $0.02"会当场穿帮。
     */
    function test_MatchesSharedCurveTable() public {
        uint256 id = _publish();
        uint64 t0 = uint64(block.timestamp);

        // steps = elapsed * 32 / 120
        vm.warp(t0 + 15); // steps 4
        assertEq(clock.currentPrice(id), 9_170_040);
        vm.warp(t0 + 60); // steps 16
        assertEq(clock.currentPrice(id), 7_071_067);
        vm.warp(t0 + 120); // steps 32 -> 整一个半衰期
        assertEq(clock.currentPrice(id), 5_000_000);
    }

    /**
     * floorPrice 只有在"自然衰减会掉到它下面"时才有意义。
     * $10 起始 + 8 个半衰期免费 ⇒ 自然最低点是 $10/128 = $0.078，
     * 所以地板必须设在 $0.078 以上才拦得住。这里用 $0.5。
     */
    function test_FloorHoldsPrice() public {
        vm.prank(publisher);
        uint256 id = clock.publish(unicode"测试消息", "", HASH, BASE, 500_000, HALF_LIFE);
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

    // ---------------------------------------------------------------- 链上购买

    function test_BuySplitsRevenue() public {
        uint256 id = _publish();
        uint128 p = clock.currentPrice(id);

        uint128 pubBefore = uint128(usdc.balanceOf(publisher));
        uint128 tBefore = uint128(usdc.balanceOf(treasury));

        vm.prank(buyer1);
        uint128 paid = clock.buy(id);

        assertEq(paid, p);

        AlphaClock.Access memory a = clock.accessOf(id, buyer1);
        assertEq(a.at, uint64(block.timestamp), unicode"Access 单槽记录时间");
        assertEq(a.price, p, unicode"Access 单槽记录成交价");

        uint128 fee = uint128((uint256(p) * 500) / 10_000);
        assertEq(usdc.balanceOf(publisher), pubBefore + (p - fee), "publisher gets 95%");
        assertEq(usdc.balanceOf(treasury), tBefore + fee, "treasury gets 5%");
        assertEq(usdc.balanceOf(address(clock)), 0, "contract custodies nothing");
    }

    function test_BuyEmitsBought() public {
        uint256 id = _publish();
        vm.expectEmit(true, true, false, true, address(clock));
        emit AlphaClock.Bought(id, buyer1, BASE, 0, false);
        vm.prank(buyer1);
        clock.buy(id);
    }

    function test_CannotBuyTwice() public {
        uint256 id = _publish();
        vm.prank(buyer1);
        clock.buy(id);

        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.AlreadyOwn.selector);
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
        assertEq(clock.accessOf(id, buyer1).price, BASE);
        assertEq(clock.accessOf(id, buyer2).price, BASE / 2);
    }

    function test_CannotBuyAfterFree() public {
        uint256 id = _publish();
        vm.warp(uint64(block.timestamp) + HALF_LIFE * 8);
        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.FreeAlready.selector);
        clock.buy(id);
    }

    // ---------------------------------------------------------------- 免费领取

    function test_ClaimFreeRevertsBeforeFree() public {
        uint256 id = _publish();
        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.NotFreeYet.selector);
        clock.claimFree(id);
    }

    function test_ClaimFreeRecordsZeroPriceAndEmits() public {
        uint256 id = _publish();
        vm.warp(uint64(block.timestamp) + HALF_LIFE * 8);

        vm.expectEmit(true, true, false, true, address(clock));
        emit AlphaClock.Claimed(id, buyer1, HALF_LIFE * 8);
        vm.prank(buyer1);
        clock.claimFree(id);

        AlphaClock.Access memory a = clock.accessOf(id, buyer1);
        assertEq(a.at, uint64(block.timestamp));
        assertEq(a.price, 0, unicode"免费领取价格必须为 0");
    }

    function test_CannotClaimTwice() public {
        uint256 id = _publish();
        vm.warp(uint64(block.timestamp) + HALF_LIFE * 8);

        vm.prank(buyer1);
        clock.claimFree(id);

        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.AlreadyOwn.selector);
        clock.claimFree(id);
    }

    /// 已经付过钱的人在免费后不该再领一次（会覆盖掉 paidPrice）
    function test_PaidBuyerCannotClaimFree() public {
        uint256 id = _publish();
        vm.prank(buyer1);
        clock.buy(id);

        vm.warp(uint64(block.timestamp) + HALF_LIFE * 8);

        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.AlreadyOwn.selector);
        clock.claimFree(id);

        assertEq(clock.accessOf(id, buyer1).price, BASE, unicode"付款记录不被免费领取覆盖");
    }

    // ---------------------------------------------------------------- x402

    function test_RecordX402OnlyByVerifier() public {
        uint256 id = _publish();
        // 本测试合约就是 verifier
        clock.recordX402(id, buyer1, 5_000_000);

        AlphaClock.Access memory a = clock.accessOf(id, buyer1);
        assertEq(a.price, 5_000_000);
        assertGt(a.at, 0);

        vm.prank(buyer2);
        vm.expectRevert(AlphaClock.NotVerifier.selector);
        clock.recordX402(id, buyer2, 5_000_000);
    }

    function test_X402EmitsViaX402Flag() public {
        uint256 id = _publish();
        vm.expectEmit(true, true, false, true, address(clock));
        emit AlphaClock.Bought(id, buyer1, 4_000_000, 0, true);
        clock.recordX402(id, buyer1, 4_000_000);
    }

    function test_X402RejectsZeroPriceAndDoubleRecord() public {
        uint256 id = _publish();
        vm.expectRevert(AlphaClock.BadParams.selector);
        clock.recordX402(id, buyer1, 0);

        clock.recordX402(id, buyer1, 1_000_000);
        vm.expectRevert(AlphaClock.AlreadyOwn.selector);
        clock.recordX402(id, buyer1, 1_000_000);
    }

    // ---------------------------------------------------------------- 提前公开

    function test_OpenNowClosesBuying() public {
        uint256 id = _publish();

        vm.expectEmit(true, true, false, true, address(clock));
        emit AlphaClock.Opened(id, publisher, uint64(block.timestamp));
        vm.prank(publisher);
        clock.openNow(id);

        assertEq(clock.currentPrice(id), 0);
        assertEq(clock.timeToFree(id), 0);
        assertTrue(clock.getSignal(id).forcedOpen);

        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.Closed.selector);
        clock.buy(id);
    }

    function test_OpenNowOnlyPublisher() public {
        uint256 id = _publish();
        vm.prank(buyer1);
        vm.expectRevert(AlphaClock.NotOwner.selector);
        clock.openNow(id);
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
            assertEq(clock.accessOf(id, b).price, p);
            console.log(i * 15, p);
            console.log("            total:", total);
        }
        assertEq(clock.accessOf(id, address(uint160(0x1000))).price, BASE, unicode"第一个人原价");
        assertLt(clock.accessOf(id, address(uint160(0x1007))).price, (BASE * 6) / 10, unicode"105 秒后不到六折");
    }
}
