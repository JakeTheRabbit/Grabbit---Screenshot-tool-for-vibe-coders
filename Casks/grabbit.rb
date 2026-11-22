cask "grabbit" do
  arch arm: "aarch64", intel: "x64"

  version "2.0.19"
  sha256 arm:   "8aa8db44aad4098f980af3bda88e93e3d4467db814759f60d4164fd3a30232fd",
         intel: "398e145b7b4e27dfde147d5d39069f6420fcf378d44d89248f0a45390071f165"

  url "https://github.com/JakeTheRabbit/Grabbit---Screenshot-tool-for-vibe-coders/releases/download/v#{version}/Grabbit_#{version}_#{arch}.dmg"
  name "Grabbit"
  desc "Screenshots and screen recordings, straight to the clipboard"
  homepage "https://jaketherabbit.github.io/Grabbit---Screenshot-tool-for-vibe-coders/"

  depends_on macos: ">= :ventura"

  app "Grabbit.app"

  # Not notarised by Apple yet, so clear the download flag that makes macOS block it.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/Grabbit.app"]
  end

  zap trash: [
    "~/Library/Application Support/app.grabbit",
    "~/Library/Caches/app.grabbit",
    "~/Library/Logs/app.grabbit",
  ]

  caveats <<~EOS
    Allow Screen Recording (and Microphone) for Grabbit in
    System Settings → Privacy & Security.
    Recording needs ffmpeg: brew install ffmpeg
  EOS
end
