#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
brand=custom_components/lightinator_log_service/brand
mkdir -p "$brand"
for theme in light dark; do
    prefix=
    if [ "$theme" = dark ]; then
        prefix=dark_
    fi
    for size in 256 512; do
        suffix=
        if [ "$size" = 512 ]; then
            suffix=@2x
        fi
        magick -background none "images/lightinator-log-service-icon-$theme.svg" \
            -resize "${size}x${size}" "$brand/${prefix}icon${suffix}.png"
    done
done
magick "$brand/icon.png" lightinator_log_service/icon.png