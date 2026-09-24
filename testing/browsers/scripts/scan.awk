/^#/ { next }
{
  split($0, a, /[:,()]+/)
  x = a[1] + 0; y = a[2] + 0
  r = a[3] + 0; g = a[4] + 0; b = a[5] + 0
  if (r >= min && r < thr && g >= min && g < thr && b >= min && b < thr) {
    k = int(x / step) "," int(y / step)
    c[k]++
  }
}
END {
  for (j = 0; j < rows; j++) {
    line = sprintf("%3d |", j * step)
    for (i = 0; i < cols; i++) {
      n = c[i "," j] + 0
      ch = (n == 0 ? "·" : (n < 5 ? "." : (n < 20 ? "+" : (n < 50 ? "o" : "O"))))
      line = line " " ch
    }
    print line
  }
}