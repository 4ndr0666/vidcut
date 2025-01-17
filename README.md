# Vid-Cut

This is just [Flawless-Cut](https://github.com/metadream/app-flawless-cut) with some extra mods I tweaked for precise cutting of clips. Slow down, speed up, etc.

![Software Interface](https://raw.githubusercontent.com/metadream/app-flawless-cut/master/screenshot.png)

## My Tweaks

- Irrdescent glowing buttons (cyan) on hover
- Speed control for precise cutting
- Slow-down 
- Speed-up

## Caveats 

**Arch Linux**: When the building is completed a .deb file will be created in the dist dir. I personally use `debtap` from the AUR to install this.

Additionally, a prefered electron mirror is found at https://npm.taobao.org/mirrors/electron/. To use it set the environment variable:

```
export ELECTRON_MIRROR="https://npm.taobao.org/mirrors/electron/"
```

---

## Development/Test-Run

```
npm start
```

---

## Build by Platform

```
npm run build:linux
npm run build:win
```

---

## Installation 

### 1. Dependencies (Arch Linux)

```
yay -S libxcrypt-compat electron nvm node
```

### 2. Install with NPM

```
npm install
```

