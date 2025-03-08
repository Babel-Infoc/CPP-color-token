#include <iostream>

// Test color RGB array definitions in different formats
// All should be detected and given color preview

// Regular RGB color arrays
const int RED[] = {255, 0, 0};
const int GREEN[] = {0, 255, 0};
const int BLUE[] = {0, 0, 255};
const int WHITE[] = {255, 255, 255};

// RGB values with various spacing
const int YELLOW[] = { 255,255,0 };
const int MAGENTA[] = {255, 0, 255};
const int CYAN[] = {0,255,255};
const int BLACK[] = {0, 0, 0};

// RGB defined directly in code
void setBackgroundColor() {
    // This should show color preview
    setColor({128, 128, 128}); // Medium gray

    // These should all show color previews
    std::cout << "Colors: " << std::endl;
    std::cout << "Orange: {255, 165, 0}" << std::endl;
    std::cout << "Purple: {128, 0, 128}" << std::endl;
    std::cout << "Pink: {255, 192, 203}" << std::endl;
}
