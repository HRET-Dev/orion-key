"use client"

import { useState, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { ShoppingBag, Mail, CreditCard, Lock } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useCart, useAuth } from "@/lib/context"
import { couponApi, orderApi, paymentApi, withMockFallback, getApiErrorMessage } from "@/services/api"
import { mockPaymentChannels, mockCreateOrder } from "@/lib/mock-data"
import {
  validateEmail,
  generateIdempotencyKey,
  getCurrencySymbol,
  detectPaymentDevice,
  isMobileDevice,
  isPaymentRedirectTarget,
  postToPaymentPage,
} from "@/lib/utils"
import { PaymentSelector } from "@/components/shared/payment-selector"
import { Turnstile, useTurnstile } from "@/components/shared/turnstile"
import { setTurnstileHeaders } from "@/services/api"
import type { CouponPreviewResult, PaymentChannelItem } from "@/types"

export default function CheckoutPage() {
  const { t } = useLocale()
  const router = useRouter()
  const { items, totalAmount, itemCount, refreshCart } = useCart()
  const { user, isLoggedIn } = useAuth()

  const [email, setEmail] = useState("")
  const [channels, setChannels] = useState<PaymentChannelItem[]>([])
  const [selectedPayment, setSelectedPayment] = useState("")
  const [couponCode, setCouponCode] = useState("")
  const [appliedCoupon, setAppliedCoupon] = useState<CouponPreviewResult | null>(null)
  const [applyingCoupon, setApplyingCoupon] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const { turnstileToken, setTurnstileToken, handleTurnstileReset } = useTurnstile()
  const payableAmount = appliedCoupon ? appliedCoupon.actual_amount : totalAmount

  // Fetch payment channels on mount
  useEffect(() => {
    let cancelled = false
    async function fetchChannels() {
      try {
        const chs = await withMockFallback(
          () => paymentApi.getChannels(),
          () => mockPaymentChannels
        )
        if (!cancelled) {
          const enabled = chs.filter(c => c.is_enabled)
          setChannels(enabled)
          if (enabled.length > 0) setSelectedPayment(enabled[0].channel_code)
        }
      } catch {
        if (!cancelled) {
          setChannels([])
        }
      }
    }
    fetchChannels()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setAppliedCoupon(null)
  }, [itemCount, totalAmount])

  useEffect(() => {
    if (!email.trim() && user?.email) {
      setEmail(user.email)
    }
  }, [user, email])

  const handleApplyCoupon = async () => {
    const code = couponCode.trim()
    if (!code) {
      toast.error("请输入优惠券码")
      return
    }
    if (items.length === 0) {
      toast.error("购物车为空")
      return
    }
    setApplyingCoupon(true)
    try {
      const result = await couponApi.preview({
        code,
        items: items.map((item) => ({
          product_id: item.product_id,
          spec_id: item.spec_id,
          quantity: item.quantity,
        })),
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

  const handleConfirmOrder = async () => {
    const orderEmail = email.trim() || user?.email?.trim() || ""

    if (!orderEmail) {
      toast.error(t("product.emailRequired"))
      emailInputRef.current?.focus()
      return
    }
    if (!validateEmail(orderEmail)) {
      toast.error(t("product.emailInvalid"))
      emailInputRef.current?.focus()
      return
    }
    if (!selectedPayment) {
      toast.error(t("product.paymentMethod"))
      return
    }

    setSubmitting(true)
    try {
      setTurnstileHeaders(turnstileToken)
      const device = detectPaymentDevice()
      const result = await withMockFallback(
        () => orderApi.createFromCart({
          email: orderEmail,
          payment_method: selectedPayment,
          coupon_code: appliedCoupon?.code,
          idempotency_key: generateIdempotencyKey(),
          device,
        }),
        () => mockCreateOrder(orderEmail, selectedPayment)
      )
      await refreshCart()
      if (result.order.status === "PAID" || result.order.status === "DELIVERED") {
        toast.success("订单已完成")
        router.push(`/order/query?orderId=${result.order.id}`)
        return
      }
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

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center gap-3">
        <ShoppingBag className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold text-foreground">{t("checkout.title")}</h1>
      </div>

      <div className="space-y-6">
        {/* Order summary */}
        <div className="rounded-lg border border-border bg-background p-6">
          <h2 className="mb-4 text-base font-semibold text-foreground">{t("checkout.summary")}</h2>
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {item.product_title}
                  {item.spec_name ? ` (${item.spec_name})` : ""}
                  {" x"}{item.quantity}
                </span>
                <span className="font-medium text-foreground">{getCurrencySymbol(item.currency)}{item.subtotal.toFixed(2)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-border pt-3">
              <span className="text-base font-medium text-foreground">{t("checkout.totalAmount")}</span>
              <span className="text-2xl font-bold text-primary">
                {getCurrencySymbol(items[0]?.currency)}{totalAmount.toFixed(2)}
              </span>
            </div>
            {appliedCoupon && (
              <>
                <div className="flex items-center justify-between text-sm text-emerald-600">
                  <span>优惠券折扣</span>
                  <span>-{getCurrencySymbol(items[0]?.currency)}{appliedCoupon.discount_amount.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-base font-medium text-foreground">实付金额</span>
                  <span className="text-2xl font-bold text-primary">
                    {getCurrencySymbol(items[0]?.currency)}{payableAmount.toFixed(2)}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Email */}
        <div className="rounded-lg border border-border bg-background p-6">
          <div className="mb-4 flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              {t("product.email")}
            </h2>
          </div>
          <input
            ref={emailInputRef}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={isLoggedIn && user?.email ? user.email : t("product.emailPlaceholder")}
            className="mb-2 w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            {isLoggedIn && user?.email ? `已自动带入账号邮箱：${user.email}` : t("product.emailFullHint")}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-background p-6">
          <div className="mb-4 flex items-center gap-2">
            <ShoppingBag className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">优惠券</h2>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={couponCode}
              onChange={(e) => {
                setCouponCode(e.target.value.toUpperCase())
                if (appliedCoupon) setAppliedCoupon(null)
              }}
              placeholder="输入优惠券码"
              className="h-10 flex-1 rounded-lg border border-input bg-background px-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {appliedCoupon ? (
              <button
                type="button"
                onClick={handleRemoveCoupon}
                className="rounded-lg border border-input px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                移除
              </button>
            ) : (
              <button
                type="button"
                onClick={handleApplyCoupon}
                disabled={applyingCoupon}
                className="rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {applyingCoupon ? "校验中..." : "应用"}
              </button>
            )}
          </div>
          {appliedCoupon && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <p className="font-medium">{appliedCoupon.name}</p>
              {appliedCoupon.min_order_amount > 0 && (
                <p>门槛 ¥{appliedCoupon.min_order_amount.toFixed(2)}，已命中 ¥{appliedCoupon.eligible_amount.toFixed(2)}</p>
              )}
              <p>已优惠 ¥{appliedCoupon.discount_amount.toFixed(2)}，待支付 ¥{appliedCoupon.actual_amount.toFixed(2)}</p>
            </div>
          )}
        </div>

        {/* Payment method */}
        <div className="rounded-lg border border-border bg-background p-6">
          <div className="mb-4 flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              {t("product.paymentMethod")}
            </h2>
          </div>
          <PaymentSelector
            channels={channels}
            selected={selectedPayment}
            onSelect={setSelectedPayment}
          />
          {selectedPayment.startsWith("usdt_") && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("payment.usdt.rateHint")}
            </p>
          )}
        </div>

        {/* Security notice */}
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <Lock className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">{t("checkout.securePayment")}</p>
            <p>{t("checkout.securePaymentDesc")}</p>
          </div>
        </div>

        <Turnstile onSuccess={setTurnstileToken} onError={handleTurnstileReset} className="mb-4" />

        {/* Confirm button */}
        <button
          onClick={handleConfirmOrder}
          disabled={submitting || items.length === 0}
          className="scheme-glow w-full rounded-lg bg-primary py-3.5 text-base font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:pointer-events-none disabled:opacity-50"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              {t("checkout.processingOrder")}
            </span>
          ) : (
            <>{t("checkout.confirmOrder")} {getCurrencySymbol(items[0]?.currency)}{payableAmount.toFixed(2)}</>
          )}
        </button>
      </div>
    </div>
  )
}
