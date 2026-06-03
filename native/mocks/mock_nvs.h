#pragma once
// In-memory INvs (mocks the ESP32's Preferences/NVS). It models the FLASH
// chip: its contents survive a simulated deep-sleep "reset" because the
// MockNvs object outlives the per-boot RAM buffers. The native harness uses
// this to drive the REAL name_store.cpp logic across resets.
#include "name_store.h"
#include <map>
#include <string>
#include <cstring>

struct MockNvs : INvs {
  std::map<std::string, std::string> store; // the persistent "flash"
  int reads = 0, writes = 0;

  bool nvsGetString(const char *key, char *out, size_t outsz) override {
    reads++;
    auto it = store.find(key);
    if (it == store.end() || it->second.empty()) return false;
    std::strncpy(out, it->second.c_str(), outsz - 1);
    out[outsz - 1] = '\0';
    return true;
  }
  bool nvsPutString(const char *key, const char *val) override {
    writes++;
    store[key] = val ? val : "";
    return true;
  }
};
