"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface SliderProps {
  className?: string
  min?: number
  max?: number
  step?: number
  value?: number[]
  defaultValue?: number[]
  onValueChange?: (value: number[]) => void
  disabled?: boolean
  size?: "default" | "sm"
}

function Slider({
  className,
  min = 0,
  max = 100,
  step = 1,
  value,
  defaultValue,
  onValueChange,
  disabled,
}: SliderProps) {
  const currentValue = value?.[0] ?? defaultValue?.[0] ?? min
  const ratio = ((currentValue - min) / (max - min)) * 100

  return (
    <div
      data-slot="slider"
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none",
        className,
      )}
    >
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-700">
        <div
          className="absolute h-full rounded-full bg-blue-500"
          style={{ width: `${ratio}%` }}
        />
      </div>
      <div
        className="pointer-events-none absolute size-4 rounded-full border-2 border-blue-500 bg-white shadow-sm"
        style={{ left: `calc(${ratio}% - 8px)` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={currentValue}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          onValueChange?.([v])
        }}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  )
}

export { Slider }
