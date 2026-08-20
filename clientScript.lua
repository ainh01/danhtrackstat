-- trackstat client — runs in the Roblox executor (Steal An Egg)
-- Collects ALL pet data (same fields as Remote/dump_inventory.lua) and POSTs
-- it to the trackstat backend every 5 seconds. No verification, no keys.
--
-- Endpoint: http://sae.trackstat.ninja/api/report
-- Body:     { username = <LocalPlayer.Name>, pets = [ ...pet tables... ] }
--
-- Standalone: no shared state, degrades gracefully if HTTP is unavailable.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local ENDPOINT = "http://sae.trackstat.ninja/api/report"
local INTERVAL = 5

-- ---------- resolve the request function (portable across executors) ----------
local environment = type(getgenv) == "function" and getgenv() or _G
local requestFunction =
    (syn and syn.request)          -- Synapse
    or (http and http.request)     -- some executors: http.request
    or http_request                -- global http_request
    or environment.request         -- getgenv().request
    or function(opts)              -- last resort: Roblox built-in
        return HttpService:RequestAsync(opts)
    end

local function postJson(url, data)
    local ok, res = pcall(requestFunction, {
        Url = url,
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode(data),
    })
    if not ok then
        return false, tostring(res)
    end
    if not res or tonumber(res.StatusCode) ~= 200 then
        return false, "HTTP " .. tostring(res and res.StatusCode)
    end
    return true
end

-- ---------- pet collection (mirrors Remote/dump_inventory.lua) ----------
local Save = require(ReplicatedStorage.Library.Client.Save)
local Assets = require(ReplicatedStorage.Directory.Assets)
local Mutations = require(ReplicatedStorage.Library.Modules.Mutations)
local AssetItemSerialization = require(ReplicatedStorage.Library.Util.AssetItemSerialization)
local AssetGenerationUtil = require(ReplicatedStorage.Library.Util.AssetGenerationUtil)
local wcall = require(ReplicatedStorage.Library.Functions.wcall)

-- Display name like the game builds it (ItemDisplay.lua:104).
local function displayName(category, itemData)
    local cfg = Assets.Directory[category]
    local base = (cfg and cfg.DisplayName) or category
    local parts = {}
    local seen = {}
    local function add(id)
        if id and id ~= "" and not seen[id] then
            seen[id] = true
            local ok, name = pcall(Mutations.GetDisplayName, id)
            parts[#parts + 1] = ok and name or id
        end
    end
    add(itemData.BaseMutation)
    if itemData.Mutations then
        for _, id in ipairs(itemData.Mutations) do
            add(id)
        end
    end
    if #parts == 0 then
        return base
    end
    return table.concat(parts, " + ") .. " " .. base
end

local function collectPets()
    local save = Save.Get()
    local inventory = save and save.Inventory
    if not inventory then
        return nil
    end
    local equipped = save and save.EquippedAssets or {}
    local rebirth = save and (tonumber(save.Rebirth) or 0) or 0
    local gamepasses = save and save.Gamepasses or {}

    local pets = {}
    for uid, raw in pairs(inventory) do
        local ok, pet = wcall(AssetItemSerialization.Deserialize, raw)
        if not ok then
            continue
        end
        local cfg = Assets.Directory[pet.Category]
        local rarity = cfg and cfg.Rarity and cfg.Rarity._id or "?"
        local modelWeight = cfg and (tonumber(cfg.ModelWeight) or 1) or 1
        local weight = modelWeight * math.max(pet.Scale or 1, 0)
        local isEquipped = table.find(equipped, uid) ~= nil

        local okRate, rate = pcall(AssetGenerationUtil.GetRate, pet, rebirth, gamepasses)
        local okRate2, rateDisplay = pcall(AssetGenerationUtil.GetRateWithoutRebirth, pet, gamepasses)

        pets[#pets + 1] = {
            uid = uid,
            category = pet.Category,
            name = displayName(pet.Category, pet),
            icon = cfg and cfg.Icon or nil,
            whiteImage = cfg and cfg.WhiteImage or nil,
            rarity = rarity,
            scale = pet.Scale,
            weight = weight,
            generatedMoney = pet.GeneratedMoney,
            perSecond = okRate and rate or nil,
            perSecondDisplay = okRate2 and rateDisplay or nil,
            mutations = pet.Mutations or {},
            baseMutation = pet.BaseMutation,
            mutationIcons = cfg and cfg.MutationIcons or nil,
            personality = pet.Personality,
            gender = pet.Gender,
            eyeColor = pet.EyeColor,
            colorSeed = pet.ColorSeed,
            colorIndex = pet.ColorIndex,
            isFavorite = pet.IsFavorite,
            inFuse = pet.InFuse,
            equipped = isEquipped,
            hasBeenFirstPlaced = pet.HasBeenFirstPlaced,
            isStolenDNA = pet.IsStolenDNA,
            lastTick = pet.LastTick,
            claimed = pet.Claimed,
            pendingEggName = pet.PendingEggName,
            earningRate = cfg and cfg.EarningRate or nil,
            dropWeight = cfg and cfg.DropWeight or nil,
            modelWeight = modelWeight,
        }
    end
    return pets
end

-- ---------- main loop: report every 5s ----------
local player = Players.LocalPlayer
local username = player and player.Name or "unknown"
print(string.format("[trackstat] started — reporting pets for '%s' to %s every %ss", username, ENDPOINT, INTERVAL))

while true do
    task.wait(INTERVAL)
    local pets = collectPets()
    if not pets then
        warn("[trackstat] Save.Get().Inventory is nil (game not loaded?) — skipping this tick")
        continue
    end
    local ok, err = postJson(ENDPOINT, { username = username, pets = pets })
    if ok then
        print(string.format("[trackstat] reported %d pets for '%s'", #pets, username))
    else
        warn(string.format("[trackstat] report failed: %s", tostring(err)))
    end
end