"""去除颱風渦旋，求出環境風場（Davis et al. 2008；Galarneau and Davis 2013）。

颱風中心 r0（500 公里）內的相對渦度 ζ 與輻散 δ，用平面上的 Green 函數（Biot–Savart）
反推它們在整個網格上造成的旋轉風與輻散風：

  u_ψ = -1/(2π) ∬ ζ' (y-y')/r² dA'    v_ψ = 1/(2π) ∬ ζ' (x-x')/r² dA'
  u_χ =  1/(2π) ∬ δ' (x-x')/r² dA'    v_χ = 1/(2π) ∬ δ' (y-y')/r² dA'

總風場扣掉這兩項就是環境風。SHIPS 的 SHDC（去除渦旋後 0–500 公里平均的 200–850 hPa 風切）
也是同樣做法。只用 numpy，網格為經緯度（緯度、經度都遞增，單位度）。
"""

from __future__ import annotations

import numpy as np

EARTH_R = 6.371e6  # 公尺
R0_KM = 500.0
_CHUNK = 2048  # 一次計算的目標點數，限制記憶體用量


def distance_km(lat0, lon0, lat, lon):
    p0, p = np.deg2rad(lat0), np.deg2rad(lat)
    a = np.sin((p - p0) / 2) ** 2 + np.cos(p0) * np.cos(p) * np.sin(np.deg2rad(lon - lon0) / 2) ** 2
    return 2 * EARTH_R / 1000 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def vort_div(u, v, lat, lon):
    """球面上的相對渦度與輻散（1/s），邊界用單邊差分。"""
    phi = np.deg2rad(lat)
    lam = np.deg2rad(lon)
    cos = np.cos(phi)[:, None]
    du_dlam = np.gradient(u, lam, axis=1)
    dv_dlam = np.gradient(v, lam, axis=1)
    ducos_dphi = np.gradient(u * cos, phi, axis=0)
    dvcos_dphi = np.gradient(v * cos, phi, axis=0)
    zeta = (dv_dlam - ducos_dphi) / (EARTH_R * cos)
    div = (du_dlam + dvcos_dphi) / (EARTH_R * cos)
    return zeta, div


def remove_vortex(winds, lat, lon, clat, clon, r0_km=R0_KM):
    """winds 是各層的 (u, v)，回傳各層去除渦旋後的 (u, v)。各層共用同一個中心。"""
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    inside = distance_km(clat, clon, la, lo) <= r0_km
    # 以颱風中心為原點的局部平面座標（公尺）
    cos = np.cos(np.deg2rad(la))
    x = EARTH_R * np.deg2rad(lo - clon) * cos
    y = EARTH_R * np.deg2rad(la - clat)
    area = EARTH_R ** 2 * np.deg2rad(np.gradient(lat))[:, None] * np.deg2rad(np.gradient(lon))[None, :] * cos

    # 每層兩欄（ζ dA、δ dA），各層一起算可以共用核函數
    cols = []
    for u, v in winds:
        zeta, div = vort_div(u, v, lat, lon)
        cols += [zeta[inside], div[inside]]
    src = np.stack(cols, axis=1) * (area[inside] / (2 * np.pi))[:, None]
    xs, ys = x[inside], y[inside]

    xt, yt = x.ravel(), y.ravel()
    induced = np.empty((xt.size, len(cols), 2))
    for i in range(0, xt.size, _CHUNK):
        dx = xt[i:i + _CHUNK, None] - xs[None, :]
        dy = yt[i:i + _CHUNK, None] - ys[None, :]
        r2 = dx * dx + dy * dy
        # 格點對自己的貢獻依對稱性為 0
        r2[r2 == 0] = np.inf
        induced[i:i + _CHUNK, :, 0] = (dx / r2) @ src
        induced[i:i + _CHUNK, :, 1] = (dy / r2) @ src

    out = []
    for k, (u, v) in enumerate(winds):
        z, d = 2 * k, 2 * k + 1
        u_vortex = -induced[:, z, 1] + induced[:, d, 0]
        v_vortex = induced[:, z, 0] + induced[:, d, 1]
        out.append((u - u_vortex.reshape(u.shape), v - v_vortex.reshape(v.shape)))
    return out


def area_mean(u, v, lat, lon, clat, clon, r_km=R0_KM):
    """中心 r_km 內的向量平均（依面積加權）。"""
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    w = np.where(distance_km(clat, clon, la, lo) <= r_km, np.cos(np.deg2rad(la)), 0.0)
    return float((u * w).sum() / w.sum()), float((v * w).sum() / w.sum())


def direction_from(du, dv):
    """風切向量的「來向」（度，0 為北、順時針）：200 hPa 西風比 850 hPa 強時為 270（西風切）。"""
    return float(np.degrees(np.arctan2(du, dv)) + 180) % 360
