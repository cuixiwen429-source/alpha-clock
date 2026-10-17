// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * AlphaClock — 信息的时间价格
 *
 * 一条信息的售价不是固定的，它是时间的函数：
 *
 *      price(t) = basePrice >> floor((t - publishedAt) / halfLife)
 *
 * 每经过一个半衰期，价格减半。到 floorPrice 为止，再经过 OPEN_HALVINGS
 * 个半衰期后永久免费公开。
 *
 * 设计取舍（重要）：
 *   价格是纯时间函数 —— 不随购买次数变化，不随出价变化，没有任何人可以
 *   调高或调低它。卖家不能改，平台不能改，合约 owner 也不能改。
 *   唯一能改变价格的是区块时间戳本身。
 *
 *   这是这个产品的核心承诺：你付的钱，对应的是"你比市场早看到了多久"，
 *   而不是"卖家今天心情如何"。
 *
 * 为什么必须高频：
 *   一条热门信息的 Alpha 半衰期在 2 分钟以内（PolyHub 对 Polymarket
 *   2023 笔链上成交的复盘）。这段时间里可能有几百个人以几百个不同的
 *   价格买走它。每笔都是一次真实结算。
 *   以太坊 12 秒一个块 —— 2 分钟只有 10 个块。
 *   Monad 400 毫秒一个块 —— 2 分钟有 300 个块。
 *   这不是"更快"，是"窗口里塞得下的事件数差 30 倍"。
 */
contract AlphaClock {
    using SafeERC20 for IERC20;

    /// @dev 经过这么多个半衰期后，信息永久免费公开
    uint32 public constant OPEN_HALVINGS = 8;

    /// @dev 每个半衰期切成 32 档，价格连续下滑而不是阶梯跳变
    uint256 public constant STEPS_PER_HALF = 32;
    uint256 private constant WAD = 1e18;

    /// @dev 平台抽成上限（基点），硬编码 5%
    uint16 public constant PROTOCOL_FEE_BPS = 500;
    uint16 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;
    address public immutable treasury;

    /// @dev 被授权把 x402 链下结算结果写回链上的地址（服务器热钱包）
    address public verifier;
    address public owner;

    struct Signal {
        address publisher;
        uint64 publishedAt;
        uint128 basePrice; // micro-USDC (6 位小数)
        uint128 floorPrice;
        uint32 halfLife; // 秒
        uint32 buyCount;
        uint128 revenue;
        bool forcedOpen;
        string title;
        string previewURI; // 免费摘要，任何人可读
        string contentURI; // 加密全文，付款后由 API 返回密钥
    }

    uint256 public signalCount;
    mapping(uint256 => Signal) internal _signals;

    /// @notice signalId => buyer => 是否已获得访问权
    mapping(uint256 => mapping(address => bool)) public hasAccess;
    /// @notice signalId => buyer => 当时实际支付的价格
    mapping(uint256 => mapping(address => uint128)) public paidPrice;

    event Published(
        uint256 indexed id,
        address indexed publisher,
        string title,
        uint128 basePrice,
        uint128 floorPrice,
        uint32 halfLife
    );
    event Bought(
        uint256 indexed id,
        address indexed buyer,
        uint128 price,
        uint32 buyCount,
        uint64 elapsed,
        bool viaX402
    );
    event Opened(uint256 indexed id, uint64 at, uint32 buyCount, uint128 revenue);
    event VerifierChanged(address indexed previous, address indexed next);

    error NotOwner();
    error NotVerifier();
    error Closed();
    error BadParams();
    error FreeAlready();
    error PriceMoved();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 _usdc, address _treasury, address _verifier) {
        usdc = _usdc;
        treasury = _treasury;
        verifier = _verifier;
        owner = msg.sender;
    }

    // ---------------------------------------------------------------- 发布

    /**
     * @param basePrice  发布瞬间的价格（micro-USDC）。$10 = 10_000_000
     * @param floorPrice 价格下限。低于它就一直停在它上面，直到免费公开
     * @param halfLife   半衰期（秒）。突发消息 30–120，深度研究 3600+
     */
    function publish(
        string calldata title,
        string calldata previewURI,
        string calldata contentURI,
        uint128 basePrice,
        uint128 floorPrice,
        uint32 halfLife
    ) external returns (uint256 id) {
        if (basePrice == 0 || halfLife == 0) revert BadParams();
        if (floorPrice > basePrice) revert BadParams();
        if (bytes(title).length == 0) revert BadParams();

        id = ++signalCount;
        Signal storage s = _signals[id];
        s.publisher = msg.sender;
        s.publishedAt = uint64(block.timestamp);
        s.basePrice = basePrice;
        s.floorPrice = floorPrice;
        s.halfLife = halfLife;
        s.title = title;
        s.previewURI = previewURI;
        s.contentURI = contentURI;

        emit Published(id, msg.sender, title, basePrice, floorPrice, halfLife);
    }

    // ---------------------------------------------------------------- 定价

    /**
     * @notice 任意时刻的价格。纯函数，不读任何可写状态。
     * @dev 衰减粒度是 1/32 个半衰期，而不是整个半衰期 —— 价格是连续下滑的曲线，
     *      不是"卡住不动然后突然减半"的阶梯。演示时这条曲线就是产品本身。
     *      实现方式：整数部分用位移（>>），小数部分查 32 项定点表，一次乘法。
     */
    function priceAt(uint256 id, uint64 t) public view returns (uint128) {
        Signal storage s = _signals[id];
        if (s.publisher == address(0)) return 0;
        if (s.forcedOpen) return 0;
        if (t <= s.publishedAt) return s.basePrice;

        uint64 elapsed = t - s.publishedAt;
        uint256 steps = (uint256(elapsed) * STEPS_PER_HALF) / s.halfLife;

        if (steps >= uint256(OPEN_HALVINGS) * STEPS_PER_HALF) return 0; // 已免费公开

        uint256 intPart = steps / STEPS_PER_HALF;
        uint256 fracIdx = steps % STEPS_PER_HALF;

        uint256 p = ((uint256(s.basePrice) >> intPart) * _fracTable()[fracIdx]) / WAD;
        uint128 price = uint128(p);
        return price < s.floorPrice ? s.floorPrice : price;
    }

    /// @dev 2^(-i/32) × 1e18，i ∈ [0, 31]
    function _fracTable() private pure returns (uint256[32] memory t) {
        t[0] = 1_000_000_000_000_000_000;
        t[1] = 978_572_062_087_700_096;
        t[2] = 957_603_280_698_573_696;
        t[3] = 937_083_817_055_149_952;
        t[4] = 917_004_043_204_671_232;
        t[5] = 897_354_537_501_553_536;
        t[6] = 878_126_080_186_649_728;
        t[7] = 859_309_649_061_238_912;
        t[8] = 840_896_415_253_714_560;
        t[9] = 822_877_739_076_982_528;
        t[10] = 805_245_165_974_627_200;
        t[11] = 787_990_422_553_943_296;
        t[12] = 771_105_412_703_970_432;
        t[13] = 754_582_213_796_711_424;
        t[14] = 738_413_072_969_749_632;
        t[15] = 722_590_403_488_523_264;
        t[16] = 707_106_781_186_547_584;
        t[17] = 691_954_940_981_916_032;
        t[18] = 677_127_773_468_446_336;
        t[19] = 662_618_321_579_870_720;
        t[20] = 648_419_777_325_504_768;
        t[21] = 634_525_478_595_866_624;
        t[22] = 620_928_906_036_742_016;
        t[23] = 607_623_679_990_234_496;
        t[24] = 594_603_557_501_360_512;
        t[25] = 581_862_429_388_788_736;
        t[26] = 569_394_317_378_345_792;
        t[27] = 557_193_371_297_946_240;
        t[28] = 545_253_866_332_628_864;
        t[29] = 533_570_200_338_411_840;
        t[30] = 522_136_891_213_706_880;
        t[31] = 510_948_574_327_058_304;
    }

    /// @notice 此刻的价格
    function currentPrice(uint256 id) external view returns (uint128) {
        return priceAt(id, uint64(block.timestamp));
    }

    /// @notice 距离价格降到 0（永久公开）还有多少秒
    function timeToFree(uint256 id) external view returns (uint64) {
        Signal storage s = _signals[id];
        if (s.publisher == address(0) || s.forcedOpen) return 0;
        uint64 deadline = s.publishedAt + uint64(s.halfLife) * OPEN_HALVINGS;
        return deadline <= block.timestamp ? 0 : deadline - uint64(block.timestamp);
    }

    /// @notice 价格从 basePrice 掉到当前值，已经衰减了多少个半衰期
    function halvingsElapsed(uint256 id) public view returns (uint256) {
        Signal storage s = _signals[id];
        if (s.publisher == address(0) || block.timestamp <= s.publishedAt) return 0;
        return (uint64(block.timestamp) - s.publishedAt) / s.halfLife;
    }

    function isFree(uint256 id) public view returns (bool) {
        return priceAt(id, uint64(block.timestamp)) == 0;
    }

    // ---------------------------------------------------------------- 购买

    /**
     * @notice 链上直接购买。需先 approve 本合约。
     * @dev 钱 95% 直接给发布者，5% 给 treasury。合约不留存任何资金。
     */
    function buy(uint256 id) external returns (uint128 paid) {
        Signal storage s = _signals[id];
        if (s.publisher == address(0)) revert BadParams();
        if (s.forcedOpen) revert Closed();

        uint64 nowTs = uint64(block.timestamp);
        paid = priceAt(id, nowTs);
        if (paid == 0) revert FreeAlready();
        if (hasAccess[id][msg.sender]) revert PriceMoved();

        uint128 fee = uint128((uint256(paid) * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR);
        usdc.safeTransferFrom(msg.sender, s.publisher, paid - fee);
        if (fee > 0) usdc.safeTransferFrom(msg.sender, treasury, fee);

        _record(id, msg.sender, paid, nowTs, false);
    }

    /**
     * @notice x402 链下结算后，由 verifier 把成交写回链上。
     * @dev 资金已在 x402 结算时从买家直接流向发布者，这里只记录访问权。
     *      verifier 是服务器热钱包；生产环境应换成 ERC-8004 的 validation
     *      registry 或 zk 证明，黑客松范围内保持最小实现。
     */
    function recordX402(uint256 id, address buyer, uint128 price) external {
        if (msg.sender != verifier) revert NotVerifier();
        Signal storage s = _signals[id];
        if (s.publisher == address(0)) revert BadParams();
        if (s.forcedOpen) revert Closed();
        if (hasAccess[id][buyer]) revert PriceMoved();
        _record(id, buyer, price, uint64(block.timestamp), true);
    }

    function _record(uint256 id, address buyer, uint128 price, uint64 nowTs, bool viaX402) private {
        Signal storage s = _signals[id];
        s.buyCount += 1;
        s.revenue += price;
        hasAccess[id][buyer] = true;
        paidPrice[id][buyer] = price;

        emit Bought(id, buyer, price, s.buyCount, nowTs - s.publishedAt, viaX402);

        // 卖够 OPEN_HALVINGS 个半衰期后自动免费，不用任何人手动触发
        if (nowTs - s.publishedAt >= uint64(s.halfLife) * OPEN_HALVINGS) {
            s.forcedOpen = true;
            emit Opened(id, nowTs, s.buyCount, s.revenue);
        }
    }

    /// @notice 发布者可以提前把信息送给所有人（比如消息已经公开了）
    function openNow(uint256 id) external {
        Signal storage s = _signals[id];
        if (msg.sender != s.publisher) revert NotOwner();
        if (s.forcedOpen) revert Closed();
        s.forcedOpen = true;
        emit Opened(id, uint64(block.timestamp), s.buyCount, s.revenue);
    }

    // ---------------------------------------------------------------- 视图

    struct SignalView {
        address publisher;
        string title;
        string previewURI;
        string contentURI;
        uint64 publishedAt;
        uint128 basePrice;
        uint128 floorPrice;
        uint32 halfLife;
        uint32 buyCount;
        uint128 revenue;
        uint128 price;
        bool freeNow;
    }

    function getSignal(uint256 id) external view returns (SignalView memory v) {
        Signal storage s = _signals[id];
        v.publisher = s.publisher;
        v.title = s.title;
        v.previewURI = s.previewURI;
        v.contentURI = s.contentURI;
        v.publishedAt = s.publishedAt;
        v.basePrice = s.basePrice;
        v.floorPrice = s.floorPrice;
        v.halfLife = s.halfLife;
        v.buyCount = s.buyCount;
        v.revenue = s.revenue;
        v.price = priceAt(id, uint64(block.timestamp));
        v.freeNow = v.price == 0;
    }

    /**
     * @notice 画出完整价格曲线：从发布到免费，取 samples 个采样点。
     * @dev 前端直接拿这个数组画图，不需要自己算衰减。
     */
    function curve(uint256 id, uint32 samples) external view returns (uint128[] memory prices, uint64[] memory times) {
        Signal storage s = _signals[id];
        uint64 deadline = s.publishedAt + uint64(s.halfLife) * OPEN_HALVINGS;
        prices = new uint128[](samples);
        times = new uint64[](samples);
        uint64 span = deadline - s.publishedAt;
        for (uint32 i = 0; i < samples; i++) {
            uint64 t = s.publishedAt + (span * i) / samples;
            times[i] = t - s.publishedAt;
            prices[i] = priceAt(id, t);
        }
    }

    function accessCount(uint256 id) external view returns (uint32) {
        return _signals[id].buyCount;
    }

    // ---------------------------------------------------------------- 管理

    function setVerifier(address next) external onlyOwner {
        emit VerifierChanged(verifier, next);
        verifier = next;
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
    }
}
