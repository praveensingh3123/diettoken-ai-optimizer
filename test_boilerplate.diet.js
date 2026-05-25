"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateEnterpriseRevenueAndTax = calculateEnterpriseRevenueAndTax;
/* [imports omitted] */ ;
/* [imports omitted] */ ;
/* [imports omitted] */ ;
const logger = new Logger({
    level: LogLevel.INFO,
    format: "%(asctime)s [%(levelname)s] %(message)s"
});
;
// DIETTOKEN SAFE BLOCK
// We protect essential business logic using <ext_safe> tags
// DietToken will completely ignore this block during compression.
const API_KEY = process.env.API_KEY || "default_secure_key";
/ext_safe>;
function calculateEnterpriseRevenueAndTax(baseRevenue, taxRate) {
    const total = baseRevenue;
    const taxAmount = total * taxRate;
    const finalAmount = total + taxAmount;
    return finalAmount;
}
if (require.main === module) {
    logger.info("Initializing enterprise application...");
    console.log(calculateEnterpriseRevenueAndTax(100000.0, 0.20));
}
//# sourceMappingURL=test_boilerplate.diet.js.map