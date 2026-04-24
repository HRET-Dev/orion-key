"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Zap, Minus, Plus, ShoppingCart, Package, TrendingUp } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useCart } from "@/lib/context"
import { couponApi, orderApi, withMockFallback, getApiErrorMessage, setTurnstileHeaders } from "@/services/api"
import { mockCreateOrder } from "@/lib/mock-data"
import { Turnstile, useTurnstile } from "@/components/shared/turnstile"
import {
  cn,
  validateEmail,
  generateIdempotencyKey,
  getCurrencySymbol,
  detectPaymentDevice,
  isMobileDevice,
  isPaymentRedirectTarget,
  postToPaymentPage,
} from "@/lib/utils"
import { PaymentSelector } from "@/components/shared/payment-selector"
import type { CouponPreviewResult, ProductDetail, ProductSpec, PaymentChannelItem } from "@/types"

interface ProductActionsProps {
  product: ProductDetail
  channels: PaymentChannelItem[]
}

export function ProductActions({ product, channels }: ProductActionsProps) {
  const { t } = useLocale()
  const { addItem } = useCart()
  const router = useRouter()
  const emailInputRef = useRef<HTMLInputElement>(null)

  const enabledChannels = useMemo(() => channels.filter(c => c.is_enabled), [channels])

  const [selectedSpec, setSelectedSpec] = useState<ProductSpec | null>(
    product.specs?.[0] || null
  )
  const [quantity, setQuantity] = useState(1)
  const [email, setEmail] = useState("")
  const [emailError, setEmailError] = useState("")
  const [selectedPayment, setSelectedPayment] = useState(
    enabledChannels.length > 0 ? enabledChannels[0].channel_code : ""
  )
  const [couponCode, setCouponCode] = useState("")
  const [appliedCoupon, setAppliedCoupon] = useState<CouponPreviewResult | null>(null)
  const [applyingCoupon, setApplyingCoupon] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const { turnstileToken, setTurnstileToken, handleTurnstileReset } = useTurnstile()

  const baseUnitPrice = selectedSpec ? selectedSpec.price : product.base_price
  const wholesaleRules = useMemo(() => {
    if (!product.wholesale_enabled) return []
    const targetSpecId = selectedSpec?.id ?? null
    return [...(product.wholesale_rules ?? [])]
      .filter((rule) => (targetSpecId ? rule.spec_id === targetSpecId : !rule.spec_id))
      .sort((a, b) => a.min_quantity - b.min_quantity)
  }, [product.wholesale_enabled, product.wholesale_rules, selectedSpec?.id])
  const matchedWholesaleRule = useMemo(() => {
    let matched = null
    for (const rule of wholesaleRules) {
      if (quantity >= rule.min_quantity) {
        matched = rule
      }
    }
    return matched
  }, [quantity, wholesaleRules])
  const currentPrice = matchedWholesaleRule?.unit_price ?? baseUnitPrice
  const totalPrice = currentPrice * quantity
  const payablePrice = appliedCoupon ? appliedCoupon.actual_amount : totalPrice
  const currentStock = selectedSpec?.stock_available ?? product.stock_available ?? 0
  const isOutOfStock = currentStock === 0
  const deliveryType = product.delivery_type === "MANUAL" ? "manual" : "auto"

  useEffect(() => {
    setAppliedCoupon(null)
  }, [product.id, selectedSpec?.id, quantity])

  const handleEmailChange = (value: string) => {
    setEmail(value)
    if (value && !validateEmail(value)) {
      setEmailError(t("product.emailInvalid"))
    } else {
      setEmailError("")
    }
  }

  const handleBuyNow = async () => {
    if (!email.trim()) {
      toast.error(t("product.emailRequired"))
      emailInputRef.current?.focus()
      emailInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
      return
    }
    if (!validateEmail(email)) {
      toast.error(t("product.emailInvalid"))
      emailInputRef.current?.focus()
      return
    }
    if (!selectedPayment) {
      toast.error(t("product.paymentMethod"))
      return
    }
    if (product.specs.length > 0 && !selectedSpec) return
    if (isOutOfStock) {
      toast.error(t("product.outOfStock"))
      return
    }

    setSubmitting(true)
    try {
      setTurnstileHeaders(turnstileToken)
      const device = detectPaymentDevice()
      const result = await withMockFallback(
        () => orderApi.create({
          product_id: product.id,
          spec_id: selectedSpec?.id ?? null,
          quantity,
          email,
          payment_method: selectedPayment,
          coupon_code: appliedCoupon?.code,
          idempotency_key: generateIdempotencyKey(),
          device,
        }),
        () => mockCreateOrder(email, selectedPayment)
      )
      toast.success(t("checkout.processingOrder"))
      if (result.payment.hosted_page_action && result.payment.hosted_page_fields) {
        postToPaymentPage(result.payment.hosted_page_action, result.payment.hosted_page_fields)
        return
      }
      const payUrlH5 = result.payment.pay_url || ""
      const redirectTarget = isPaymentRedirectTarget(payUrlH5) ? payUrlH5 : ""
      const qr = result.payment.qrcode_url || result.payment.payment_url || ""
      let payUrl = `/pay/${result.payment.order_id}?method=${selectedPayment}`
      if (qr) payUrl += `&qr=${encodeURIComponent(qr)}`
      if (redirectTarget) payUrl += `&payurl=${encodeURIComponent(redirectTarget)}`
      // USDT 支付额外参数
      if (result.payment.wallet_address) {
        payUrl += `&wallet=${encodeURIComponent(result.payment.wallet_address)}`
        payUrl += `&crypto_amount=${encodeURIComponent(result.payment.crypto_amount || "")}`
        payUrl += `&chain=${encodeURIComponent(result.payment.chain || "")}`
      }
      const paymentCode = selectedPayment.toLowerCase()
      // 码支付默认使用网关收银台页面，不走站内嵌入页
      if (paymentCode.startsWith("codepay_") && redirectTarget) {
        sessionStorage.setItem(`pay_redirected_${result.payment.order_id}`, "1")
        window.location.href = redirectTarget
        return
      }
      // 移动端非 USDT 非微信：直接跳转网关支付页，避免中间经过 pay 页面的延迟
      // 导致支付宝 H5 session token 过期（"会话超时"）
      // 微信支付的 jspay 走 JSAPI（需微信浏览器），普通浏览器不能跳转，只能到 pay 页展示二维码
      const isWechat = paymentCode.includes("wechat") || paymentCode.includes("wxpay")
      if (isMobileDevice() && redirectTarget && !selectedPayment.startsWith("usdt_") && !isWechat) {
        sessionStorage.setItem(`pay_redirected_${result.payment.order_id}`, "1")
        window.location.href = redirectTarget
        return
      }
      router.push(payUrl)
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t))
      handleTurnstileReset()
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddToCart = async () => {
    if (product.specs.length > 0 && !selectedSpec) return
    if (isOutOfStock) {
      toast.error(t("product.outOfStock"))
      return
    }
    try {
      await addItem({
        product_id: product.id,
        spec_id: selectedSpec?.id ?? null,
        quantity,
      })
      toast.success(t("product.addToCart"))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t))
    }
  }

  const handleApplyCoupon = async () => {
    const code = couponCode.trim()
    if (!code) {
      toast.error("请输入优惠券码")
      return
    }
    setApplyingCoupon(true)
    try {
      const result = await couponApi.preview({
        code,
        items: [
          {
            product_id: product.id,
            spec_id: selectedSpec?.id ?? null,
            quantity,
          },
        ],
      })
      setAppliedCoupon(result)
      setCouponCode(result.code)
      toast.success(`优惠券已生效，已减免 ¥${result.discount_amount.toFixed(2)}`)
    } catch (err: unknown) {
      setAppliedCoupon(null)
      toast.error(getApiErrorMessage(err, t))
    } finally {
      setApplyingCoupon(false)
    }
  }

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null)
    setCouponCode("")
  }

  return (
    <div className="lg:sticky lg:top-4 flex flex-col gap-4">
      {/* Title */}
      <div>
        <h1 className="text-xl font-bold text-foreground">
          {product.title}
        </h1>
      </div>

      {/* Price + Specs + Stock */}
      <div className="rounded-lg border border-border p-4 space-y-4">
        {/* Price row + delivery status */}
        <div className="flex flex-wrap items-baseline justify-between gap-y-2">
          <div className="flex items-baseline gap-3">
            <div className="flex items-baseline gap-0.5">
              <span className="text-lg font-extrabold text-primary">{getCurrencySymbol(product.currency)}</span>
              <span className="text-2xl font-extrabold text-primary">
                {currentPrice.toFixed(2)}
              </span>
            </div>
            {currentPrice !== baseUnitPrice && (
              <span className="text-sm text-muted-foreground line-through">
                {getCurrencySymbol(product.currency)}{baseUnitPrice.toFixed(2)}
              </span>
            )}
          </div>

          {/* Delivery status indicator */}
          <div className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1",
            deliveryType === "auto"
              ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20"
              : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20"
          )}>
            <span className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              deliveryType === "auto" ? "bg-emerald-500" : "bg-amber-400"
            )}>
              {deliveryType === "auto" && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              )}
            </span>
            <span className={cn(
              "text-xs font-semibold",
              deliveryType === "auto"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-amber-600 dark:text-amber-300"
            )}>
              {deliveryType === "auto" ? t("product.deliveryAuto") : t("product.deliveryManual")}
            </span>
          </div>
        </div>

        {/* Stock + Sales */}
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Package className="h-3.5 w-3.5" />
            {t("product.stock")} {selectedSpec?.stock_available ?? product.stock_available}
          </span>
          {((product.sales_count ?? 0) + (product.initial_sales ?? 0)) > 0 && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              {t("product.sold")} {(product.sales_count ?? 0) + (product.initial_sales ?? 0)}
            </span>
          )}
        </div>

        {wholesaleRules.length > 0 && (
          <div className="rounded-lg border border-primary/15 bg-primary/5 p-3">
            <p className="text-xs font-medium text-foreground">
              档位价
              {matchedWholesaleRule && (
                <span className="ml-2 text-primary">
                  已命中满 {matchedWholesaleRule.min_quantity} 件，每件 {getCurrencySymbol(product.currency)}{matchedWholesaleRule.unit_price.toFixed(2)}
                </span>
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {wholesaleRules.map((rule) => {
                const active = quantity >= rule.min_quantity
                return (
                  <div
                    key={`${rule.spec_id ?? "default"}-${rule.min_quantity}`}
                    className={cn(
                      "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground"
                    )}
                  >
                    满 {rule.min_quantity} 件 {getCurrencySymbol(product.currency)}{rule.unit_price.toFixed(2)}/件
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Spec selection */}
        {product.specs && product.specs.length > 1 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">
              {t("product.selectSpec")}
            </label>
            <div className="flex flex-wrap gap-2">
              {product.specs.map((spec) => (
                <button
                  key={spec.id}
                  onClick={() => {
                    setSelectedSpec(spec)
                    setQuantity(1)
                  }}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    selectedSpec?.id === spec.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-foreground hover:border-primary/30"
                  )}
                  disabled={spec.stock_available === 0}
                >
                  {spec.name}
                  {spec.stock_available === 0 && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({t("product.outOfStock")})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Action area */}
      <div className="rounded-lg border border-border p-4 space-y-4">
        {/* Quantity */}
        <div>
          <label className="mb-2 block text-sm font-medium text-foreground">
            {t("product.quantity")}
          </label>
          <div className="inline-flex items-center rounded-md border border-border">
            <button
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              className="inline-flex h-9 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-accent"
              disabled={quantity <= 1}
            >
              <Minus className="h-4 w-4" />
            </button>
            <input
              type="number"
              min={1}
              max={currentStock || 1}
              value={quantity}
              onChange={(e) => {
                const v = parseInt(e.target.value) || 1
                setQuantity(Math.min(v, currentStock || 1))
              }}
              className="h-9 w-16 border-x border-border bg-background text-center text-sm text-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <button
              onClick={() => setQuantity(Math.min(quantity + 1, currentStock || 1))}
              className="inline-flex h-9 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-accent"
              disabled={quantity >= currentStock}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Email input */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            {t("product.email")}
          </label>
          <input
            ref={emailInputRef}
            type="email"
            placeholder={t("product.emailPlaceholder")}
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            className={cn(
              "h-10 w-full rounded-lg border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring",
              emailError ? "border-destructive" : "border-input"
            )}
          />
          <div className="mt-1.5">
            <p className="text-xs text-muted-foreground">
              {t("product.emailFullHint")}
            </p>
            {emailError && (
              <p className="mt-1 text-xs text-destructive">{emailError}</p>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            优惠券
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={couponCode}
              onChange={(e) => {
                setCouponCode(e.target.value.toUpperCase())
                if (appliedCoupon) setAppliedCoupon(null)
              }}
              placeholder="输入优惠券码"
              className="h-10 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {appliedCoupon ? (
              <button
                type="button"
                onClick={handleRemoveCoupon}
                className="rounded-lg border border-input px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                移除
              </button>
            ) : (
              <button
                type="button"
                onClick={handleApplyCoupon}
                disabled={applyingCoupon}
                className="rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {applyingCoupon ? "校验中..." : "应用"}
              </button>
            )}
          </div>
          {appliedCoupon && (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <p className="font-medium">{appliedCoupon.name}</p>
              {appliedCoupon.min_order_amount > 0 && (
                <p>门槛 ¥{appliedCoupon.min_order_amount.toFixed(2)}，已命中 ¥{appliedCoupon.eligible_amount.toFixed(2)}</p>
              )}
              <p>已优惠 ¥{appliedCoupon.discount_amount.toFixed(2)}，待支付 ¥{appliedCoupon.actual_amount.toFixed(2)}</p>
            </div>
          )}
        </div>

        {/* Payment method */}
        <div>
          <label className="mb-2 block text-sm font-medium text-foreground">
            {t("product.paymentMethod")}
          </label>
          <PaymentSelector
            channels={enabledChannels}
            selected={selectedPayment}
            onSelect={setSelectedPayment}
          />
        </div>

        {/* Total */}
        <div className="flex items-baseline justify-between border-t border-border pt-4">
          <span className="text-sm text-muted-foreground">{t("product.totalPrice")}</span>
          <div className="flex flex-col items-end gap-1">
            {appliedCoupon && (
              <span className="text-sm text-emerald-600">
                优惠券折扣 -{getCurrencySymbol(product.currency)}{appliedCoupon.discount_amount.toFixed(2)}
              </span>
            )}
            <div className="flex items-baseline gap-0.5">
              <span className="text-lg font-bold text-primary">{getCurrencySymbol(product.currency)}</span>
              <span className="text-2xl font-bold text-primary">
                {payablePrice.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <Turnstile onSuccess={setTurnstileToken} onError={handleTurnstileReset} className="mb-3" />

        {/* Action Buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleBuyNow}
            disabled={submitting || isOutOfStock}
            className="scheme-glow inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:pointer-events-none disabled:opacity-50"
          >
            {submitting ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {isOutOfStock ? t("product.outOfStock") : `${t("product.buyNow")} ${getCurrencySymbol(product.currency)}${payablePrice.toFixed(2)}`}
          </button>
          <button
            onClick={handleAddToCart}
            disabled={isOutOfStock}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <ShoppingCart className="h-4 w-4" />
            {t("product.addToCart")}
          </button>
        </div>
      </div>
    </div>
  )
}
