package com.orionkey.config;

import com.orionkey.service.CouponService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class CouponSecurityIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private CouponService couponService;

    @Test
    void guestCanPreviewCouponWithoutAuthentication() throws Exception {
        given(couponService.previewCoupon(anyMap())).willReturn(Map.of(
                "code", "SAVE10",
                "name", "Save 10",
                "discount_amount", new BigDecimal("10.00"),
                "actual_amount", new BigDecimal("90.00"),
                "min_order_amount", BigDecimal.ZERO,
                "eligible_amount", new BigDecimal("100.00"),
                "items", List.of()
        ));

        mockMvc.perform(post("/api/coupons/preview")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "code": "SAVE10",
                                  "items": [
                                    {
                                      "product_id": "11111111-1111-1111-1111-111111111111",
                                      "quantity": 1
                                    }
                                  ]
                                }
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.code").value("SAVE10"));
    }
}
